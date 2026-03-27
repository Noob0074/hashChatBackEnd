import mongoose from "mongoose";

const banSchema = new mongoose.Schema(
  {
    ipHash: {
      type: String,
    },

    fingerprint: {
      type: String,
    },

    reason: {
      type: String,
      default: "Abuse",
    },

    bannedUntil: {
      type: Date,
    },
  },
  { timestamps: true }
);

// Index on ipHash and fingerprint for quick lookups
banSchema.index({ ipHash: 1 });
banSchema.index({ fingerprint: 1 });

export default mongoose.model("Ban", banSchema);
