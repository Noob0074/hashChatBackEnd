import Message from "../models/Message.js";
import User from "../models/User.js";
import Room from "../models/Room.js";
import cloudinary from "../config/cloudinary.js";

/**
 * Cleanup Worker
 * Deletes expired media from Cloudinary and updates DB records.
 */
const cleanupExpiredMedia = async () => {
  try {
    const expiryDays = parseInt(process.env.MEDIA_EXPIRY_DAYS) || 7;
    const threshold = new Date(Date.now() - expiryDays * 24 * 60 * 60 * 1000);

    console.log(`Running media cleanup (expiry: ${expiryDays} days, threshold: ${threshold.toISOString()})...`);

    const expiredMessages = await Message.find({
      publicId: { $exists: true, $ne: null },
      type: { $ne: "text" },
      createdAt: { $lt: threshold },
      isExpired: { $ne: true },
    });

    if (expiredMessages.length === 0) {
      console.log("No expired media found.");
      return;
    }

    console.log(`Found ${expiredMessages.length} expired media items.`);

    for (const msg of expiredMessages) {
      try {
        await cloudinary.uploader.destroy(msg.publicId);
        console.log(`Deleted Cloudinary asset: ${msg.publicId}`);

        msg.content = "[Media Expired]";
        msg.isExpired = true;
        await msg.save();

        await Message.findByIdAndUpdate(msg._id, { $unset: { publicId: 1 } });
      } catch (err) {
        console.error(`Failed to cleanup message ${msg._id}:`, err.message);
      }
    }

    console.log("Media cleanup completed.");
  } catch (error) {
    console.error("Cleanup worker error:", error);
  }
};

/**
 * Cleanup Old Accounts
 * Deletes inactive guest accounts, purges old deleted non-guest users,
 * and scrubs sensitive metadata from deleted guest placeholders after retention.
 */
const cleanupOldAccounts = async () => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const deletedGuestRetentionDays = parseInt(process.env.DELETED_GUEST_RETENTION_DAYS) || 30;
    const deletedGuestCutoff = new Date(
      Date.now() - deletedGuestRetentionDays * 24 * 60 * 60 * 1000
    );

    console.log(`Running account cleanup (threshold: ${thirtyDaysAgo.toISOString()})...`);

    const scrubbedGuests = await User.updateMany(
      {
        isGuest: true,
        isDeleted: true,
        deletedAt: { $ne: null, $lte: deletedGuestCutoff },
        $or: [
          { ipHash: { $exists: true, $ne: null } },
          { fingerprint: { $exists: true, $ne: null } },
          { profilePic: { $ne: "" } },
          { profilePicPublicId: { $ne: "" } },
        ],
      },
      {
        $unset: {
          ipHash: 1,
          fingerprint: 1,
        },
        $set: {
          profilePic: "",
          profilePicPublicId: "",
        },
      }
    );

    const inactiveGuests = await User.find({
      isGuest: true,
      isDeleted: false,
      lastActive: { $lt: thirtyDaysAgo },
    });

    const oldDeletedUsers = await User.find({
      isDeleted: true,
      isGuest: false,
      updatedAt: { $lt: thirtyDaysAgo },
    });

    const targetUsers = [...inactiveGuests, ...oldDeletedUsers];

    if (targetUsers.length === 0 && (!scrubbedGuests.modifiedCount || scrubbedGuests.modifiedCount === 0)) {
      console.log("No old accounts to purge or scrub.");
      return;
    }

    for (const user of targetUsers) {
      console.log(`Purging user: ${user.username} (${user._id})`);

      await Room.deleteMany({ createdBy: user._id });
      await Room.updateMany(
        { members: user._id },
        { $pull: { members: user._id, pendingRequests: user._id } }
      );
      await User.findByIdAndDelete(user._id);
    }

    console.log(
      `Account cleanup completed (${targetUsers.length} purged, ${scrubbedGuests.modifiedCount || 0} deleted guest placeholders scrubbed).`
    );
  } catch (error) {
    console.error("Account cleanup error:", error);
  }
};

/**
 * Start the cleanup worker on a schedule
 */
export const startCleanupWorker = () => {
  const mediaCleanupIntervalMs = parseInt(process.env.MEDIA_CLEANUP_INTERVAL_MS) || 6 * 60 * 60 * 1000;
  const accountCleanupIntervalMs = parseInt(process.env.ACCOUNT_CLEANUP_INTERVAL_MS) || 24 * 60 * 60 * 1000;

  cleanupExpiredMedia();
  cleanupOldAccounts();

  setInterval(cleanupExpiredMedia, mediaCleanupIntervalMs);
  setInterval(cleanupOldAccounts, accountCleanupIntervalMs);

  console.log(
    `Maintenance workers initialized (Media: ${mediaCleanupIntervalMs}ms, Accounts: ${accountCleanupIntervalMs}ms).`
  );
};
