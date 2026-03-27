import jwt from "jsonwebtoken";
import Message from "../models/Message.js";
import Room from "../models/Room.js";
import User from "../models/User.js";
import sanitize from "../utils/sanitize.js";

// In-memory store: userId → Set of socketIds
const onlineUsers = new Map();
// Message rate limiting: userId → lastMessageTimestamps[]
const messageTimestamps = new Map();
let ioInstance;

/**
 * Initialize Socket.IO with all event handlers
 */
const initSocket = (io) => {
  // ========================
  // AUTH MIDDLEWARE
  // ========================
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.cookie
          ?.split(";")
          .find((c) => c.trim().startsWith("token="))
          ?.split("=")[1];

      if (!token) {
        return next(new Error("Unauthorized — no token"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const user = await User.findById(decoded.userId).select("-password");
      if (!user || user.isDeleted) {
        return next(new Error("Unauthorized — invalid user"));
      }

      socket.userId = decoded.userId;
      socket.username = user.username;

      next();
    } catch (err) {
      next(new Error("Unauthorized — invalid token"));
    }
  });

  // ========================
  // CONNECTION HANDLER
  // ========================
  ioInstance = io;
  io.on("connection", (socket) => {
    const userId = socket.userId;
    const username = socket.username;

    // Track online user
    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId).add(socket.id);

    console.log(`🟢 User connected: ${username} (${userId})`);

    // Broadcast online status
    io.emit("user_online", { userId, username });

    // ========================
    // JOIN ROOM
    // ========================
    socket.on("join_room", async (roomId) => {
      try {
        // Validate room access
        const room = await Room.findById(roomId);
        if (!room) {
          return socket.emit("error", { message: "Room not found" });
        }

        const isMember = room.members.some(
          (m) => m.toString() === userId.toString()
        );
        if (!isMember) {
          return socket.emit("error", { message: "Not a member of this room" });
        }

        const isBanned = room.bannedUsers.some(
          (b) => b.toString() === userId.toString()
        );
        if (isBanned) {
          return socket.emit("error", { message: "You are banned from this room" });
        }

        socket.join(roomId);
        console.log(`   📌 ${username} joined room: ${roomId}`);
      } catch (err) {
        socket.emit("error", { message: "Failed to join room" });
      }
    });

    // ========================
    // LEAVE ROOM
    // ========================
    socket.on("leave_room", (roomId) => {
      socket.leave(roomId);
      console.log(`   📌 ${username} left room: ${roomId}`);
    });

    // ========================
    // SEND MESSAGE
    // ========================
    socket.on("send_message", async (data) => {
      try {
        const { roomId, content, type = "text", fileName, publicId, resourceType } = data;
        const sanitizedFileName = fileName ? sanitize(fileName) : undefined;

        if (!roomId || !content) {
          return socket.emit("error", { message: "Room ID and content required" });
        }

        // Rate limit: 5 messages per 2 seconds
        const now = Date.now();
        const timestamps = messageTimestamps.get(userId) || [];
        const recentTimestamps = timestamps.filter(t => now - t < 2000);
        
        if (recentTimestamps.length >= 5) {
          return socket.emit("error", { message: "Message limit reached. Slow down." });
        }
        
        recentTimestamps.push(now);
        messageTimestamps.set(userId, recentTimestamps);

        // Sanitize content
        const sanitizedContent = type === "text" ? sanitize(content) : content;

        if (sanitizedContent.length > 5000) {
          return socket.emit("error", { message: "Message too long" });
        }

        // Validate room access
        const room = await Room.findById(roomId);
        if (!room) {
          return socket.emit("error", { message: "Room not found" });
        }

        const isMember = room.members.some(
          (m) => m.toString() === userId.toString()
        );
        if (!isMember) {
          return socket.emit("error", { message: "Not a member of this room" });
        }

        // Check user not deleted
        const user = await User.findById(userId);
        if (!user || user.isDeleted) {
          return socket.emit("error", { message: "Account unavailable" });
        }

        // For DM rooms, check if other user is deleted or has blocked sender
        if (room.type === "dm") {
          const otherUserId = room.members.find(
            (m) => m.toString() !== userId.toString()
          );
          if (otherUserId) {
            const otherUser = await User.findById(otherUserId).select("isDeleted blockedUsers");
            if (otherUser && otherUser.isDeleted) {
              return socket.emit("error", {
                message: "This user is no longer available",
              });
            }
            if (otherUser && otherUser.blockedUsers && otherUser.blockedUsers.includes(userId)) {
              return socket.emit("error", {
                message: "You have been blocked by this user",
              });
            }
          }
        }

        // Save message
        const message = await Message.create({
          roomId,
          senderId: userId,
          content: sanitizedContent,
          type,
          fileName: sanitizedFileName,
          publicId,
          resourceType,
        });

        // Make room visible again for users who hid it
        await Room.findByIdAndUpdate(roomId, {
          $set: { hiddenBy: [] }
        });

        // Populate sender info
        const populated = await Message.findById(message._id)
          .populate("senderId", "username isDeleted isGuest")
          .lean();

        // Broadcast to room
        io.to(roomId).emit("receive_message", populated);

        // Acknowledge to sender
        socket.emit("message_sent", { messageId: message._id });
      } catch (err) {
        console.error("Send message socket error:", err);
        socket.emit("error", { message: "Failed to send message" });
      }
    });

    // ========================
    // TYPING INDICATORS
    // ========================
    socket.on("typing", (roomId) => {
      socket.to(roomId).emit("typing", { userId, username });
    });

    socket.on("stop_typing", (roomId) => {
      socket.to(roomId).emit("stop_typing", { userId, username });
    });

    // ========================
    // ADMIN: KICK USER
    // ========================
    socket.on("kick_user", async ({ roomId, targetUserId }) => {
      try {
        const room = await Room.findById(roomId);
        if (!room || room.createdBy.toString() !== userId.toString()) {
          return socket.emit("error", { message: "Not authorized" });
        }

        // Remove from room in DB
        await Room.findByIdAndUpdate(roomId, {
          $pull: { members: targetUserId },
          $addToSet: { kickedUsers: targetUserId },
        });

        // Notify the kicked user and remove from socket room
        const targetSockets = onlineUsers.get(targetUserId);
        if (targetSockets) {
          targetSockets.forEach((sid) => {
            io.to(sid).emit("kicked", { roomId });
            io.sockets.sockets.get(sid)?.leave(roomId);
          });
        }

        // Notify room
        io.to(roomId).emit("user_kicked", { userId: targetUserId, roomId });
      } catch (err) {
        socket.emit("error", { message: "Failed to kick user" });
      }
    });

    // ========================
    // ADMIN: BAN USER
    // ========================
    socket.on("ban_user", async ({ roomId, targetUserId }) => {
      try {
        const room = await Room.findById(roomId);
        if (!room || room.createdBy.toString() !== userId.toString()) {
          return socket.emit("error", { message: "Not authorized" });
        }

        // Update DB
        await Room.findByIdAndUpdate(roomId, {
          $addToSet: { bannedUsers: targetUserId },
        });

        // Notify the banned user
        const targetSockets = onlineUsers.get(targetUserId);
        if (targetSockets) {
          targetSockets.forEach((sid) => {
            io.to(sid).emit("banned", { roomId });
            io.sockets.sockets.get(sid)?.leave(roomId);
          });
        }

        // Notify room
        io.to(roomId).emit("user_banned", { userId: targetUserId, roomId });
      } catch (err) {
        socket.emit("error", { message: "Failed to ban user" });
      }
    });

    // ========================
    // ADMIN: UNBAN USER
    // ========================
    socket.on("unban_user", async ({ roomId, targetUserId }) => {
      try {
        const room = await Room.findById(roomId);
        if (!room || room.createdBy.toString() !== userId.toString()) {
          return socket.emit("error", { message: "Not authorized" });
        }

        await Room.findByIdAndUpdate(roomId, {
          $pull: { bannedUsers: targetUserId },
        });

        // Notify room
        io.to(roomId).emit("user_unbanned", { userId: targetUserId, roomId });
      } catch (err) {
        socket.emit("error", { message: "Failed to unban user" });
      }
    });

    // ========================
    // DISCONNECT
    // ========================
    socket.on("disconnect", () => {
      const userSockets = onlineUsers.get(userId);

      if (userSockets) {
        userSockets.delete(socket.id);

        if (userSockets.size === 0) {
          onlineUsers.delete(userId);
          messageTimestamps.delete(userId);
          // Broadcast offline status
          io.emit("user_offline", { userId, username });
        }
      }

      console.log(`🔴 User disconnected: ${username} (${userId})`);
    });
  });
};

// Helper: get socket IDs for a user
export const getUserSockets = (userId) => {
  return onlineUsers.get(userId) || new Set();
};

// Helper: check if user is online
export const isUserOnline = (userId) => {
  return onlineUsers.has(userId) && onlineUsers.get(userId).size > 0;
};

// Helper: get IO instance
export const getIo = () => ioInstance;

export default initSocket;
