import mongoose from "mongoose";

const limitSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
    },

    action: {
      type: String,
      enum: ["create_account", "create_room", "upload_media", "upload_avatar", "update_avatar", "failed_login"],
      required: true,
    },

    count: {
      type: Number,
      default: 0,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }, // TTL index — auto-deletes when expired
    },
  },
  { timestamps: true }
);

// Compound index for quick lookups
limitSchema.index({ key: 1, action: 1 });

export default mongoose.model("Limit", limitSchema);
