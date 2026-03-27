import cloudinary from "../config/cloudinary.js";
import hashIP from "../utils/hashIP.js";
import { checkAndIncrement } from "../utils/rateLimiter.js";

const MEDIA_LIMIT = parseInt(process.env.DAILY_LIMIT_MEDIA) || 200;

/**
 * POST /api/files/upload-url
 * Get a Cloudinary upload signature for direct client-side upload.
 *
 * If Cloudinary is not configured, falls back to returning
 * instructions for backend-assisted upload.
 */
export const getUploadUrl = async (req, res) => {
  try {
    const { folder = "anonchat/media", resourceType = "auto" } = req.body;

    // Rate limit per IP
    const ip = req.ip || req.connection.remoteAddress;
    const ipHashed = hashIP(ip);
    const action = folder.includes('profiles') ? "upload_avatar" : "upload_media";
    const isLimited = await checkAndIncrement(ipHashed, action, MEDIA_LIMIT);

    if (isLimited) {
      return res.status(429).json({ error: `Daily upload limit reached (${MEDIA_LIMIT} files). Try again later.` });
    }

    // Check if Cloudinary is configured
    if (
      !process.env.CLOUDINARY_API_KEY ||
      !process.env.CLOUDINARY_API_SECRET ||
      process.env.CLOUDINARY_API_KEY === "your_api_key"
    ) {
      return res.status(503).json({
        error: "File upload not configured. Set Cloudinary credentials in .env",
        hint: "Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET",
      });
    }

    const timestamp = Math.round(new Date().getTime() / 1000);

    // Generate signature for direct upload
    const signature = cloudinary.utils.api_sign_request(
      {
        timestamp,
        folder,
      },
      process.env.CLOUDINARY_API_SECRET
    );

    res.json({
      signature,
      timestamp,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      folder,
      uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`,
    });
  } catch (error) {
    console.error("GET_UPLOAD_URL_ERROR:", {
      message: error.message,
      stack: error.stack,
      body: req.body,
      ip: req.ip
    });
    res.status(500).json({ 
      error: "Failed to generate upload URL", 
      details: error.message 
    });
  }
};

// =====================================================
// Backend-Assisted Upload (Alternative)
// =====================================================
// If you prefer uploading through the backend instead of
// direct client upload, use this approach with multer:
//
// import multer from "multer";
// const upload = multer({ dest: "uploads/", limits: { fileSize: 5 * 1024 * 1024 } });
//
// export const uploadFile = async (req, res) => {
//   try {
//     if (!req.file) {
//       return res.status(400).json({ error: "No file provided" });
//     }
//
//     // Validate file type
//     const allowedTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
//     if (!allowedTypes.includes(req.file.mimetype)) {
//       return res.status(400).json({ error: "File type not allowed" });
//     }
//
//     // Upload to Cloudinary
//     const result = await cloudinary.uploader.upload(req.file.path, {
//       folder: "anonchat",
//       resource_type: "auto",
//     });
//
//     // Clean up temp file
//     import fs from "fs";
//     fs.unlinkSync(req.file.path);
//
//     res.json({
//       fileUrl: result.secure_url,
//       fileName: req.file.originalname,
//       publicId: result.public_id,
//     });
//   } catch (error) {
//     console.error("Upload file error:", error);
//     res.status(500).json({ error: "File upload failed" });
//   }
// };
// =====================================================
// Media cleanup
// =====================================================
export const deleteFile = async (publicId, resourceType = "image") => {
  if (!publicId) return;
  try {
    const result = await cloudinary.uploader.destroy(publicId, { 
      resource_type: resourceType,
      invalidate: true // Force cache clearing
    });
    console.log(`Cloudinary deletion result for ${publicId} (${resourceType}):`, result);
  } catch (error) {
    console.error("Cloudinary file deletion error:", error);
  }
};
