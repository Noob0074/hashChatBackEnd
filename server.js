import express from "express";
import http from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";

// Config
const envStatus = dotenv.config();
if (envStatus.error) {
  console.error("❌ Failed to load .env file:", envStatus.error);
} else {
  console.log("✅ .env configuration loaded successfully");
}

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
const server = http.createServer(app);

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  },
});

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
// INITIALIZE SOCKET.IO
// ========================
initSocket(io);

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
