import mongoose from "mongoose";

const verificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  token: {
    type: String,
    required: true,
  },

  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 }, // TTL index — auto-deletes when expired
  },
});

export default mongoose.model("Verification", verificationSchema);
