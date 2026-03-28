import jwt from "jsonwebtoken";
import Message from "../models/Message.js";
import Room from "../models/Room.js";
import User from "../models/User.js";
import sanitize from "../utils/sanitize.js";

const SOCKET_MESSAGE_BURST_LIMIT = parseInt(process.env.SOCKET_MESSAGE_BURST_LIMIT) || 5;
const SOCKET_MESSAGE_BURST_WINDOW_MS = parseInt(process.env.SOCKET_MESSAGE_BURST_WINDOW_MS) || 2000;
const MAX_MESSAGE_LENGTH = parseInt(process.env.MAX_MESSAGE_LENGTH) || 5000;

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
  // AUTH MIDDLEWARE (Main Namespace)
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
    const hadExistingSockets = onlineUsers.has(userId) && onlineUsers.get(userId).size > 0;

    // Track online user
    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId).add(socket.id);

    console.log(`🟢 User connected: ${username} (${userId})`);

    socket.emit("presence_snapshot", {
      userIds: Array.from(onlineUsers.keys()),
    });

    // Broadcast online status only when the user's first socket connects.
    if (!hadExistingSockets) {
      io.emit("user_online", { userId, username });
    }

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

        const isKicked = room.kickedUsers.some(
          (k) => k.toString() === userId.toString()
        );
        if (isKicked) {
          return socket.emit("error", { message: "You were removed from this room" });
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

        // Rate limit burst control for socket messages
        const now = Date.now();
        const timestamps = messageTimestamps.get(userId) || [];
        const recentTimestamps = timestamps.filter(
          (t) => now - t < SOCKET_MESSAGE_BURST_WINDOW_MS
        );
        
        if (recentTimestamps.length >= SOCKET_MESSAGE_BURST_LIMIT) {
          return socket.emit("error", { message: "Message limit reached. Slow down." });
        }
        
        recentTimestamps.push(now);
        messageTimestamps.set(userId, recentTimestamps);

        // Sanitize content
        const sanitizedContent = type === "text" ? sanitize(content) : content;

        if (sanitizedContent.length > MAX_MESSAGE_LENGTH) {
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

        const isKicked = room.kickedUsers.some(
          (k) => k.toString() === userId.toString()
        );
        if (isKicked) {
          return socket.emit("error", { message: "You were removed from this room" });
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
            if (otherUser?.blockedUsers?.some((id) => id.toString() === userId.toString())) {
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

        // Broadcast to users actively viewing the room
        io.to(roomId).emit("receive_message", populated);

        // Notify all room members individually so inactive chats can update
        room.members.forEach((memberId) => {
          const memberSockets = onlineUsers.get(memberId.toString());
          if (!memberSockets) return;

          memberSockets.forEach((sid) => {
            io.to(sid).emit("room_message", populated);
          });
        });

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
    // DISCONNECT
    // ========================
    socket.on("disconnect", async () => {
      const userSockets = onlineUsers.get(userId);

      if (userSockets) {
        userSockets.delete(socket.id);

        if (userSockets.size === 0) {
          onlineUsers.delete(userId);
          messageTimestamps.delete(userId);
          const lastActive = new Date();
          await User.findByIdAndUpdate(userId, {
            $set: { lastActive },
          }).catch((error) => {
            console.error("Failed to update lastActive on disconnect:", error);
          });
          // Broadcast offline status
          io.emit("user_offline", {
            userId,
            username,
            lastActive: lastActive.toISOString(),
          });
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
