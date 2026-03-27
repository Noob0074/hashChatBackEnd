import Message from "../models/Message.js";
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
 * Start the cleanup worker on a schedule
 * Runs once immediately, then every 6 hours
 */
export const startCleanupWorker = () => {
  // Run immediately on start
  cleanupExpiredMedia();

  // Schedule to run every 6 hours (21600000 ms)
  setInterval(cleanupExpiredMedia, 6 * 60 * 60 * 1000);
  
  console.log("🚀 Media cleanup worker initialized (6h interval).");
};
