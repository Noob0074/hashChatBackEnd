import mongoose from "mongoose";

const roomSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["dm", "private", "public"],
      required: true,
    },

    name: {
      type: String,
      trim: true,
      maxlength: 50,
      sparse: true,
      unique: true,
    },

    roomPic: {
      type: String,
      default: "",
    },
    roomPicPublicId: {
      type: String, // Cloudinary public_id
      default: "",
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    members: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    pendingRequests: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    kickedUsers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    hiddenBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    accessLedger: [
      {
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        joinedAt: {
          type: Date,
          default: Date.now,
        },
        leftAt: {
          type: Date,
          default: null,
        },
      },
    ],
  },
  { timestamps: true }
);

// Performance indices for room queries
roomSchema.index({ members: 1 });
roomSchema.index({ createdBy: 1 });
roomSchema.index({ type: 1, name: 1 });

export default mongoose.model("Room", roomSchema);
