import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";

// Ensure env variables are loaded before configuration
dotenv.config();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "demo",
  api_key: process.env.CLOUDINARY_API_KEY || "",
  api_secret: process.env.CLOUDINARY_API_SECRET || "",
});

export default cloudinary;
