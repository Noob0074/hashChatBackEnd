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

    console.log(`🧹 Running media cleanup (expiry: ${expiryDays} days, threshold: ${threshold.toISOString()})...`);

    // Find messages with publicId that are older than threshold and not yet marked expired
    const expiredMessages = await Message.find({
      publicId: { $exists: true, $ne: null },
      type: { $ne: "text" },
      createdAt: { $lt: threshold },
      isExpired: { $ne: true },
    });

    if (expiredMessages.length === 0) {
      console.log("✨ No expired media found.");
      return;
    }

    console.log(`🔍 Found ${expiredMessages.length} expired media items.`);

    for (const msg of expiredMessages) {
      try {
        // 1. Delete from Cloudinary
        // Note: uploader.destroy returns { result: 'ok' } even if file doesn't exist anymore
        await cloudinary.uploader.destroy(msg.publicId);
        console.log(`   🗑️ Deleted Cloudinary asset: ${msg.publicId}`);

        // 2. Update Message in DB
        msg.content = "[Media Expired]";
        msg.isExpired = true;
        // Don't nullify publicId yet, so we don't try to delete it again if save fails
        await msg.save();
        
        // Now safely remove publicId
        await Message.findByIdAndUpdate(msg._id, { $unset: { publicId: 1 } });

      } catch (err) {
        console.error(`   ❌ Failed to cleanup message ${msg._id}:`, err.message);
      }
    }

    console.log("✅ Media cleanup completed.");
  } catch (error) {
    console.error("❌ Cleanup worker error:", error);
  }
};

/**
 * Cleanup Old Accounts
 * Deletes guest accounts inactive for 30+ days and soft-deleted users.
 */
const cleanupOldAccounts = async () => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    console.log(`🧹 Running account cleanup (threshold: ${thirtyDaysAgo.toISOString()})...`);

    // 1. Find inactive guests
    const inactiveGuests = await User.find({
      isGuest: true,
      lastActive: { $lt: thirtyDaysAgo }
    });

    // 2. Find long-term soft-deleted users
    const oldDeletedUsers = await User.find({
      isDeleted: true,
      updatedAt: { $lt: thirtyDaysAgo }
    });

    const targetUsers = [...inactiveGuests, ...oldDeletedUsers];

    if (targetUsers.length === 0) {
      console.log("✨ No old accounts to purge.");
      return;
    }

    for (const user of targetUsers) {
      console.log(`   🗑️ Purging user: ${user.username} (${user._id})`);
      
      // Clean up rooms created by this user
      await Room.deleteMany({ createdBy: user._id });
      // Remove from all other rooms
      await Room.updateMany(
        { members: user._id },
        { $pull: { members: user._id, pendingRequests: user._id } }
      );
      // Delete user
      await User.findByIdAndDelete(user._id);
    }

    console.log(`✅ Account cleanup completed (${targetUsers.length} purged).`);
  } catch (error) {
    console.error("❌ Account cleanup error:", error);
  }
};

/**
 * Start the cleanup worker on a schedule
 * Runs once immediately, then every 6 hours
 */
export const startCleanupWorker = () => {
  // Run immediately on start
  cleanupExpiredMedia();
  cleanupOldAccounts();

  // Schedule to run periodically
  setInterval(cleanupExpiredMedia, 6 * 60 * 60 * 1000); // 6h
  setInterval(cleanupOldAccounts, 24 * 60 * 60 * 1000); // 24h
  
  console.log("🚀 Maintenance workers initialized (Media: 6h, Accounts: 24h).");
};
