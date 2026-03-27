import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    roomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Room",
      required: true,
      index: true,
    },

    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    type: {
      type: String,
      enum: ["text", "image", "file"],
      default: "text",
    },

    content: {
      type: String,
      required: true,
      maxlength: 5000,
    },

    fileName: {
      type: String,
    },

    publicId: {
      type: String, // Cloudinary public_id for media
    },
    resourceType: {
      type: String, // Cloudinary resource_type: image, raw, video
    },

    isExpired: {
      type: Boolean,
      default: false,
    },
    isEdited: {
      type: Boolean,
      default: false,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Compound index for paginated message queries
messageSchema.index({ roomId: 1, createdAt: -1 });

export default mongoose.model("Message", messageSchema);
