import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import verifyJWT from "../middleware/auth.js";
import checkDeleted from "../middleware/checkDeleted.js";
import {
  createGuest,
  register,
  verifyEmail,
  resendVerification,
  login,
  logout,
  deleteAccount,
  forgotPassword,
  resetPassword,
} from "../controllers/authController.js";

const router = express.Router();

// Public routes (no auth needed)
router.post("/guest", createGuest);
router.post("/login", login);
router.get("/verify", verifyEmail);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

// Register — optionally auth'd (for guest upgrade flow)
router.post("/register", async (req, res, next) => {
  try {
    const token = req.cookies?.token || req.headers.authorization?.split(" ")[1];
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId).select("-password");
      if (user && !user.isDeleted) {
        req.userId = decoded.userId;
        req.user = user;
      }
    }
  } catch (err) {
    // Ignore JWT errors, proceed as fresh registration
  }
  next();
}, register);

// Protected routes
router.post("/logout", verifyJWT, logout);
router.post("/resend-verification", verifyJWT, checkDeleted, resendVerification);
router.delete("/me", verifyJWT, checkDeleted, deleteAccount);

export default router;
