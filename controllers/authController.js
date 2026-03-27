import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import User from "../models/User.js";
import Verification from "../models/Verification.js";
import PasswordReset from "../models/PasswordReset.js";
import Room from "../models/Room.js";
import Message from "../models/Message.js";
import Ban from "../models/Ban.js";
import generateUsername from "../utils/generateUsername.js";
import hashIP from "../utils/hashIP.js";
import sanitize from "../utils/sanitize.js";
import { checkLimit, incrementLimit, checkAndIncrement, resetLimit } from "../utils/rateLimiter.js";
import { sendVerificationEmail, sendPasswordResetEmail } from "../utils/email.js";
import { deleteFile } from "./fileController.js";

const GUEST_LIMIT = parseInt(process.env.DAILY_LIMIT_GUESTS) || 3;
const ROOM_LIMIT = parseInt(process.env.DAILY_LIMIT_ROOMS) || 5;
const REGISTER_LIMIT = parseInt(process.env.DAILY_LIMIT_REGISTER) || 5;
const MAX_RESET_ATTEMPTS = parseInt(process.env.AUTH_MAX_RESET_ATTEMPTS) || 3;
const RESET_LOCK_MINS = parseInt(process.env.AUTH_RESET_LOCK_MINS) || 60;
const MAX_VERIFY_RESENDS = parseInt(process.env.AUTH_MAX_VERIFY_RESENDS) || 3;
const VERIFY_RESEND_LOCK_MINS = parseInt(process.env.AUTH_VERIFY_RESEND_LOCK_MINS) || 30;

// Helper: generate JWT
const generateToken = (userId) => {
  const expiry = process.env.AUTH_TOKEN_EXPIRY_DAYS ? `${process.env.AUTH_TOKEN_EXPIRY_DAYS}d` : "7d";
  return jwt.sign({ userId }, process.env.JWT_SECRET, { 
    expiresIn: expiry
  });
};

// Helper: set JWT cookie
const setTokenCookie = (res, token) => {
  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
};

/**
 * POST /api/auth/guest
 * Create a temporary (guest) user
 */
export const createGuest = async (req, res) => {
  try {
    const ip = req.ip || req.connection.remoteAddress;
    const ipHashed = hashIP(ip);
    
    // Use user-agent as a fallback or secondary factor if fingerprint is missing or generic
    const clientFingerprint = req.body.fingerprint;
    const userAgent = req.headers["user-agent"] || "unknown";
    const fingerprint = (clientFingerprint && clientFingerprint !== "default") 
      ? `${clientFingerprint}_${userAgent}` 
      : userAgent;

    // Check for active bans
    const ban = await Ban.findOne({
      $or: [{ ipHash: ipHashed }, { fingerprint }],
      bannedUntil: { $gt: new Date() },
    });

    if (ban) {
      return res.status(403).json({ error: "You are temporarily banned. Try again later." });
    }

    // Rate limit: checkAndIncrement already increments — don't call incrementLimit again
    const limitKey = `${ipHashed}_${fingerprint}`;
    const isLimited = await checkAndIncrement(limitKey, "create_account", GUEST_LIMIT);

    if (isLimited) {
      return res.status(429).json({ error: `Daily limit reached (${GUEST_LIMIT} accounts). Try again later.` });
    }

    // Generate unique username
    let username = generateUsername();
    let attempts = 0;
    while (await User.findOne({ username })) {
      username = generateUsername();
      attempts++;
      if (attempts > 10) {
        return res.status(500).json({ error: "Could not generate unique username" });
      }
    }

    // Create user
    const user = await User.create({
      username,
      isGuest: true,
      ipHash: ipHashed,
      fingerprint,
    });

    // Generate JWT
    const token = generateToken(user._id);
    setTokenCookie(res, token);

    res.status(201).json({
      user: {
        _id: user._id,
        username: user.username,
        isGuest: user.isGuest,
        isVerified: user.isVerified,
        profilePic: user.profilePic,
      },
      token,
    });
  } catch (error) {
    console.error("Create guest error:", error);
    res.status(500).json({ error: "Failed to create guest account" });
  }
};

/**
 * POST /api/auth/register
 * Upgrade guest or create a new registered account
 */
export const register = async (req, res) => {
  try {
    let { username, email, password } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    const ipHashed = hashIP(ip);
    const fingerprint = req.body.fingerprint || req.headers["user-agent"] || "unknown";

    if (!username || !email || !password) {
      return res.status(400).json({ error: "Username, email, and password are required" });
    }

    // Rate limit registrations per IP (skip for guest upgrades already authenticated)
    if (!req.user?.isGuest) {
      const isLimited = await checkAndIncrement(ipHashed, "register", REGISTER_LIMIT);
      if (isLimited) {
        return res.status(429).json({ error: `Too many registrations from this IP. Try again later.` });
      }
    }

    username = sanitize(username.trim());
    email = sanitize(email.trim().toLowerCase());

    // Strict Alpha-only Username check
    const userRegex = new RegExp(process.env.AUTH_USERNAME_REGEX || "^[a-zA-Z]+$");
    if (!userRegex.test(username)) {
      return res.status(400).json({ 
        error: "Username can only contain alphabets, numbers, underscores, and dots." 
      });
    }

    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ error: "Username must be 3-30 characters" });
    }

    // Strong Password check
    const passRegex = new RegExp(process.env.AUTH_PASSWORD_REGEX || "^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&])[A-Za-z\\d@$!%*?&]{8,}$");
    if (!passRegex.test(password)) {
      return res.status(400).json({ 
        error: "Password must be at least 8 characters and include uppercase, lowercase, number, and special character" 
      });
    }

    // Check if email or username is already taken by a non-guest, non-deleted user
    const existingEmail = await User.findOne({ email, isGuest: false, isDeleted: false });
    if (existingEmail) {
      return res.status(400).json({ error: "Email already in use" });
    }

    const existingUsername = await User.findOne({ username, isDeleted: false });
    if (existingUsername) {
      return res.status(400).json({ error: "Username already taken" });
    }

    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);

    // If there's an existing guest user making this request (upgrade flow)
    let user;
    if (req.user && req.user.isGuest) {
      user = await User.findByIdAndUpdate(
        req.user._id,
        {
          username,
          email,
          password: hashedPassword,
          isGuest: false,
          isVerified: false,
        },
        { new: true }
      );
    } else {
      user = await User.create({
        username,
        email,
        password: hashedPassword,
        isGuest: false,
        isVerified: false,
        ipHash: ipHashed,
        fingerprint,
      });
    }

    // Create verification token
    const verifyToken = crypto.randomBytes(32).toString("hex");
    const emailExpiryHrs = parseInt(process.env.AUTH_EMAIL_EXPIRY_HRS) || 24;
    await Verification.create({
      userId: user._id,
      token: verifyToken,
      expiresAt: new Date(Date.now() + emailExpiryHrs * 60 * 60 * 1000),
    });

    // Send verification email
    await sendVerificationEmail(email, verifyToken);

    // Generate JWT
    const token = generateToken(user._id);
    setTokenCookie(res, token);

    res.status(201).json({
      message: "Registration successful. Verification email sent.",
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        isGuest: user.isGuest,
        isVerified: user.isVerified,
        profilePic: user.profilePic,
      },
      token,
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Registration failed" });
  }
};

/**
 * POST /api/auth/login
 */
export const login = async (req, res) => {
  try {
    let { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    email = sanitize(email.trim().toLowerCase());

    const ip = req.ip || req.connection.remoteAddress;
    const ipHashed = hashIP(ip);
    const loginKey = `${ipHashed}_${email}`;

    // Read config
    const maxLoginAttempts = parseInt(process.env.AUTH_MAX_LOGIN_ATTEMPTS) || 5;
    const lockDurationMins = parseInt(process.env.AUTH_LOGIN_LOCK_MINS) || 15;

    // Check if locked BEFORE verifying user
    const isLocked = await checkLimit(loginKey, "failed_login", maxLoginAttempts);
    if (isLocked) {
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${lockDurationMins} minutes.` });
    }

    const user = await User.findOne({ email, isDeleted: false });
    if (!user || user.isGuest) {
      await incrementLimit(loginKey, "failed_login", lockDurationMins);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      await incrementLimit(loginKey, "failed_login", lockDurationMins);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Success! Clear the limit
    await resetLimit(loginKey, "failed_login");

    // Update last active
    user.lastActive = new Date();
    await user.save();

    const token = generateToken(user._id);
    setTokenCookie(res, token);

    res.json({
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        isGuest: user.isGuest,
        isVerified: user.isVerified,
        profilePic: user.profilePic,
      },
      token,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
};

/**
 * POST /api/auth/logout
 */
export const logout = (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  });
  res.json({ message: "Logged out" });
};

/**
 * GET /api/auth/verify?token=abc
 */
export const verifyEmail = async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: "Token is required" });

    // Explicitly check expiry (TTL index can lag up to 60 seconds)
    const verificationRecord = await Verification.findOne({ 
      token,
      expiresAt: { $gt: new Date() }
    });
    if (!verificationRecord) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    await User.findByIdAndUpdate(verificationRecord.userId, { isVerified: true });
    await Verification.deleteOne({ _id: verificationRecord._id });

    res.json({ message: "Email verified successfully" });
  } catch (error) {
    console.error("Verify email error:", error);
    res.status(500).json({ error: "Verification failed" });
  }
};

/**
 * POST /api/auth/resend-verification
 */
export const resendVerification = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || user.isGuest) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.isVerified) {
      return res.status(400).json({ error: "Email already verified" });
    }

    // Rate limit by userId
    const resendKey = `${user._id}_resend_verification`;
    const isLimited = await checkLimit(resendKey, "resend_verification", MAX_VERIFY_RESENDS);
    if (isLimited) {
      return res.status(429).json({
        error: `Too many resend requests. Try again in ${VERIFY_RESEND_LOCK_MINS} minutes.`,
      });
    }
    await incrementLimit(resendKey, "resend_verification", VERIFY_RESEND_LOCK_MINS);

    // Create new token
    const verifyToken = crypto.randomBytes(32).toString("hex");
    
    // Delete old tokens
    await Verification.deleteMany({ userId: user._id });
    
    const emailExpiryHrs = parseInt(process.env.AUTH_EMAIL_EXPIRY_HRS) || 24;
    await Verification.create({
      userId: user._id,
      token: verifyToken,
      expiresAt: new Date(Date.now() + emailExpiryHrs * 60 * 60 * 1000),
    });

    await sendVerificationEmail(user.email, verifyToken);

    res.json({ message: "Verification email resent" });
  } catch (error) {
    console.error("Resend verification error:", error);
    res.status(500).json({ error: "Failed to resend email" });
  }
};

/**
 * DELETE /api/auth/me
 * Delete account (soft delete)
 */
export const deleteAccount = async (req, res) => {
  try {
    const user = req.user;

    // Mark as deleted
    user.isDeleted = true;
    await user.save();

    // Cleanup user's profile pic from Cloudinary
    if (user.profilePicPublicId) {
      deleteFile(user.profilePicPublicId);
    }

    // Find and delete all rooms created by this user
    const userRooms = await Room.find({ createdBy: user._id });
    const userRoomIds = userRooms.map((r) => r._id);

    // Cleanup room avatars from Cloudinary
    for (const room of userRooms) {
      if (room.roomPicPublicId) {
        deleteFile(room.roomPicPublicId);
      }
    }

    await Room.deleteMany({ createdBy: user._id });
    await Message.deleteMany({ roomId: { $in: userRoomIds } });

    // Remove from all other rooms
    await Room.updateMany(
      { members: user._id },
      {
        $pull: { members: user._id, pendingRequests: user._id },
      }
    );

    // Clear cookie
    res.clearCookie("token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    });

    res.json({ message: "Account deleted successfully" });
  } catch (error) {
    console.error("Delete account error:", error);
    res.status(500).json({ error: "Failed to delete account" });
  }
};

/**
 * POST /api/auth/forgot-password
 * Send reset link
 */
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    // Rate limit by IP
    const ip = req.ip || req.connection.remoteAddress;
    const ipHashed = hashIP(ip);
    const resetRateKey = `${ipHashed}_reset`;

    const isLimited = await checkLimit(resetRateKey, "forgot_password", MAX_RESET_ATTEMPTS);
    if (isLimited) {
      return res.status(429).json({
        error: `Too many reset requests. Try again in ${RESET_LOCK_MINS} minutes.`,
      });
    }

    const user = await User.findOne({ 
      email: sanitize(email.trim().toLowerCase()),
      isGuest: false,
      isDeleted: false 
    });

    // Always increment the counter regardless of whether email exists (prevent enumeration via timing)
    await incrementLimit(resetRateKey, "forgot_password", RESET_LOCK_MINS);

    // Security: Don't reveal if user exists or not
    if (!user) {
      return res.json({ message: "If an account exists with that email, we've sent a reset link." });
    }

    // Create reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    
    // Delete existing tokens for this user
    await PasswordReset.deleteMany({ userId: user._id });
    
    const resetExpiryHrs = parseInt(process.env.AUTH_PASSWORD_RESET_EXPIRY_HRS) || 1;
    await PasswordReset.create({
      userId: user._id,
      token: resetToken,
      expiresAt: new Date(Date.now() + resetExpiryHrs * 60 * 60 * 1000),
    });

    await sendPasswordResetEmail(user.email, resetToken);

    res.json({ message: "If an account exists with that email, we've sent a reset link." });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ error: "Failed to process request" });
  }
};

/**
 * POST /api/auth/reset-password
 * Handle actual reset
 */
export const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;
    
    if (!token || !password) {
      return res.status(400).json({ error: "Token and password are required" });
    }

    // Enforce full password strength (same as registration)
    const passRegex = new RegExp(process.env.AUTH_PASSWORD_REGEX || "^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&])[A-Za-z\\d@$!%*?&]{8,}$");
    if (!passRegex.test(password)) {
      return res.status(400).json({
        error: "Password must be at least 8 characters and include uppercase, lowercase, number, and special character"
      });
    }

    // Explicitly check expiry (TTL index can lag up to 60 seconds)
    const resetDoc = await PasswordReset.findOne({ token, expiresAt: { $gt: new Date() } });
    if (!resetDoc) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    const user = await User.findById(resetDoc.userId);
    if (!user || user.isDeleted) {
      return res.status(404).json({ error: "User not found" });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(12);
    user.password = await bcrypt.hash(password, salt);
    await user.save();

    // Delete the token
    await PasswordReset.deleteOne({ _id: resetDoc._id });

    res.json({ message: "Password reset successful! You can now log in with your new password." });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ error: "Failed to reset password" });
  }
};
