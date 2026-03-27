import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
    },

    password: {
      type: String,
    },

    profilePic: {
      type: String,
      default: "",
    },

    blockedUsers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    isGuest: {
      type: Boolean,
      default: true,
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },

    isVerified: {
      type: Boolean,
      default: false,
    },

    ipHash: {
      type: String,
      required: true,
    },

    fingerprint: {
      type: String,
      required: true,
    },

    lastActive: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Index for email (sparse — only indexes documents where email exists)
userSchema.index({ email: 1, isDeleted: 1 }, { unique: true, sparse: true });
userSchema.index({ username: 1, isDeleted: 1 }, { unique: true });
userSchema.index({ isDeleted: 1 });
userSchema.index({ isGuest: 1, lastActive: 1 }); // For guest cleanup worker

export default mongoose.model("User", userSchema);
