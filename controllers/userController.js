import User from "../models/User.js";
import Verification from "../models/Verification.js";
import sanitize from "../utils/sanitize.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sendVerificationEmail } from "../utils/email.js";
import { checkAndIncrement } from "../utils/rateLimiter.js";
import { deleteFile } from "./fileController.js";
import { getIo, getUserSockets } from "../socket/index.js";

const AVATAR_LIMIT = parseInt(process.env.DAILY_LIMIT_AVATAR_CHANGES) || 5;
const USERNAME_RULES_MESSAGE =
  "Username can only contain letters, numbers, underscores, and dots.";
const PASSWORD_RULES_MESSAGE =
  "Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character (such as . _ @ $ ! % * ? &).";

/**
 * GET /api/users/search?username=abc
 * Search users by username (excludes deleted users)
 */
export const searchUsers = async (req, res) => {
  try {
    const { username } = req.query;

    if (!username || username.length < 2) {
      return res.status(400).json({ error: "Search query must be at least 2 characters" });
    }

    // Escape regex special chars to prevent ReDoS
    const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const users = await User.find({
      username: { $regex: escapedUsername, $options: "i" },
      isDeleted: false,
      _id: { $ne: req.userId }, // Exclude self
    })
      .select("username isGuest isVerified profilePic")
      .limit(20);

    res.json({ users });
  } catch (error) {
    console.error("Search users error:", error);
    res.status(500).json({ error: "Search failed" });
  }
};

/**
 * GET /api/users/me
 * Get current authenticated user
 */
export const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.userId)
      .select("-password -ipHash -fingerprint")
      .populate("blockedUsers", "username profilePic");

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ user });
  } catch (error) {
    console.error("Get me error:", error);
    res.status(500).json({ error: "Failed to get user" });
  }
};

/**
 * PUT /api/users/me
 * Update user profile (username, profilePic)
 */
export const updateProfile = async (req, res) => {
  try {
    let { username, email, password, currentPassword, profilePic, profilePicPublicId } = req.body;
    const updates = {};
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Security check: require password for sensitive changes
    const emailChanged = email && email.trim().toLowerCase() !== user.email;
    if ((emailChanged || password) && !user.isGuest) {
      if (!currentPassword) {
        return res.status(400).json({ error: "Current password required for email/password updates" });
      }
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) {
        return res.status(401).json({ error: "Invalid current password" });
      }
    }

    if (username) {
      username = sanitize(username.trim());
      
      // Enforce the configured username character set
      const userRegex = new RegExp(process.env.AUTH_USERNAME_REGEX || "^[a-zA-Z]+$");
      if (!userRegex.test(username)) {
        return res.status(400).json({ error: USERNAME_RULES_MESSAGE });
      }

      if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ error: "Username must be 3-30 characters" });
      }
      const existing = await User.findOne({ username, _id: { $ne: req.userId } });
      if (existing) {
        return res.status(400).json({ error: "Username already taken" });
      }
      updates.username = username;
    }

    if (email && !user.isGuest) {
      email = sanitize(email.trim().toLowerCase());
      if (email !== user.email) {
        const existing = await User.findOne({ email, _id: { $ne: req.userId } });
        if (existing) {
          return res.status(400).json({ error: "Email already taken" });
        }
        updates.email = email;
        updates.isVerified = false;
        
        // Re-send verification email
        const verifyToken = crypto.randomBytes(32).toString("hex");
        await Verification.deleteMany({ userId: user._id });
        
        const emailExpiryHrs = parseInt(process.env.AUTH_EMAIL_EXPIRY_HRS) || 24;
        await Verification.create({
          userId: user._id,
          token: verifyToken,
          expiresAt: new Date(Date.now() + emailExpiryHrs * 60 * 60 * 1000),
        });
        await sendVerificationEmail(email, verifyToken);
      }
    }

    if (password && !user.isGuest) {
      // Enforce the configured password strength rules
      const passRegex = new RegExp(process.env.AUTH_PASSWORD_REGEX || "^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&])[A-Za-z\\d@$!%*?&]{8,}$");
      if (!passRegex.test(password)) {
        return res.status(400).json({ error: PASSWORD_RULES_MESSAGE });
      }
      const salt = await bcrypt.genSalt(12);
      updates.password = await bcrypt.hash(password, salt);
    }

    if (profilePic !== undefined && profilePic !== user.profilePic) {
      // Rate limit avatar changes
      const isLimited = await checkAndIncrement(req.userId.toString(), "update_avatar", AVATAR_LIMIT);
      if (isLimited) {
        return res.status(429).json({ error: `Daily avatar update limit reached (${AVATAR_LIMIT} changes). Try again later.` });
      }

      // Cleanup OLD Cloudinary image if it exists
      if (user.profilePicPublicId && profilePicPublicId !== user.profilePicPublicId) {
        deleteFile(user.profilePicPublicId);
      }

      updates.profilePic = profilePic;
      updates.profilePicPublicId = profilePicPublicId || "";
    }

    const updatedUser = await User.findByIdAndUpdate(req.userId, updates, { new: true })
      .select("-password -ipHash -fingerprint")
      .populate("blockedUsers", "username profilePic");

    res.json({ user: updatedUser, message: "Profile updated successfully" });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ error: "Failed to update profile" });
  }
};

/**
 * POST /api/users/block/:userId
 * Block a user (prevents DMs)
 */
export const blockUser = async (req, res) => {
  try {
    const targetUserId = req.params.userId;

    if (targetUserId === req.userId) {
      return res.status(400).json({ error: "Cannot block yourself" });
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      { $addToSet: { blockedUsers: targetUserId } },
      { new: true }
    )
      .select("-password -ipHash -fingerprint")
      .populate("blockedUsers", "username profilePic");

    const io = getIo();
    if (io) {
      const payload = { actorUserId: req.userId, targetUserId };
      getUserSockets(targetUserId.toString()).forEach((sid) => {
        io.to(sid).emit("dm_blocked", payload);
      });
      getUserSockets(req.userId.toString()).forEach((sid) => {
        io.to(sid).emit("dm_blocked", payload);
      });
    }

    res.json({ message: "User blocked", user });
  } catch (error) {
    console.error("Block user error:", error);
    res.status(500).json({ error: "Failed to block user" });
  }
};

/**
 * POST /api/users/unblock/:userId
 * Unblock a user
 */
export const unblockUser = async (req, res) => {
  try {
    const targetUserId = req.params.userId;

    const user = await User.findByIdAndUpdate(
      req.userId,
      { $pull: { blockedUsers: targetUserId } },
      { new: true }
    )
      .select("-password -ipHash -fingerprint")
      .populate("blockedUsers", "username profilePic");

    const io = getIo();
    if (io) {
      const payload = { actorUserId: req.userId, targetUserId };
      getUserSockets(targetUserId.toString()).forEach((sid) => {
        io.to(sid).emit("dm_unblocked", payload);
      });
      getUserSockets(req.userId.toString()).forEach((sid) => {
        io.to(sid).emit("dm_unblocked", payload);
      });
    }

    res.json({ message: "User unblocked", user });
  } catch (error) {
    console.error("Unblock user error:", error);
    res.status(500).json({ error: "Failed to unblock user" });
  }
};
