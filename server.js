import "./config/env.js";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import { instrument } from "@socket.io/admin-ui";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";

// Environment variables are loaded by config/env.js (imported above)

// Fail-fast if critical environment variables are missing
const CRITICAL_VARS = ["MONGO_URI", "JWT_SECRET"];
CRITICAL_VARS.forEach((v) => {
  if (!process.env[v]) {
    console.error(`❌ CRITICAL ERROR: Missing required environment variable: ${v}`);
    process.exit(1);
  }
});

import connectDB from "./config/db.js";
import { startCleanupWorker } from "./utils/cleanup.js";
import initSocket from "./socket/index.js";

// Route imports
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import roomRoutes from "./routes/rooms.js";
import messageRoutes from "./routes/messages.js";
import fileRoutes from "./routes/files.js";
import configRoutes from "./routes/config.js";

// Initialize Express
const app = express();
app.set("trust proxy", 1); // Trust first proxy (e.g., Render, Vercel, Cloudflare)
const server = http.createServer(app);

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: [
      process.env.FRONTEND_URL || "http://localhost:5173",
      "https://admin.socket.io"
    ],
    credentials: true,
  },
});

// Instrument Socket.IO Admin UI only when explicitly enabled.
// This avoids exposing an admin surface with weak fallback credentials.
import bcrypt from "bcryptjs";
const socketAdminEnabled = process.env.ENABLE_SOCKET_ADMIN === "true";
if (socketAdminEnabled) {
  const adminUsername = process.env.SOCKET_ADMIN_USERNAME;
  const adminPassword = process.env.SOCKET_ADMIN_PASSWORD;

  if (!adminUsername || !adminPassword) {
    console.error("Socket admin is enabled, but SOCKET_ADMIN_USERNAME or SOCKET_ADMIN_PASSWORD is missing.");
    process.exit(1);
  }

  const hashedPassword = bcrypt.hashSync(adminPassword, 10);
  instrument(io, {
    auth: {
      type: "basic",
      username: adminUsername,
      password: hashedPassword,
    },
    mode: process.env.NODE_ENV === "production" ? "production" : "development",
  });
}

// Initialize socket handlers
initSocket(io);

// ========================
// MIDDLEWARE
// ========================

// Security headers
app.use(helmet());

// CORS
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  })
);

// Body parsers
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Cookie parser
app.use(cookieParser());

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // limit each IP to 200 requests per windowMs
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// Auth-specific rate limiter (stricter)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many auth attempts, please try again later." },
});

// ========================
// ROUTES
// ========================

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// API routes
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/rooms", roomRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/config", configRoutes);
app.use("/api/report", (req, res) => res.status(410).json({ error: "Feature removed." }));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("❌ Server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ========================
// START SERVER
// ========================
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    // Connect to MongoDB
    await connectDB();

    // Start media cleanup worker
    startCleanupWorker();

    // Start server
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`
╔══════════════════════════════════════════╗
║   🚀 AnonChat Server Running            ║
║   📡 Port: ${PORT}                         ║
║   🗄️  DB: MongoDB (local)                ║
║   🔌 Socket.IO: Ready                   ║
╚══════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
