import Room from "../models/Room.js";
import Message from "../models/Message.js";
import User from "../models/User.js";
import sanitize from "../utils/sanitize.js";
import { checkLimit, incrementLimit, checkAndIncrement } from "../utils/rateLimiter.js";
import { getIo, getUserSockets } from "../socket/index.js";

const ROOM_LIMIT = parseInt(process.env.DAILY_LIMIT_ROOMS) || 5;

/**
 * POST /api/rooms
 * Create a new room (public or private)
 */
export const createRoom = async (req, res) => {
  try {
    let { type, name } = req.body;

    // Validate
    if (!type || !["public", "private"].includes(type)) {
      return res.status(400).json({ error: "Type must be 'public' or 'private'" });
    }

    name = sanitize(name?.trim());
    
    // Strict Alpha-only Room Name check
    const roomRegex = new RegExp(process.env.AUTH_ROOMNAME_REGEX || "^[a-zA-Z]+$");
    if (!roomRegex.test(name)) {
      return res.status(400).json({ error: "Room name must contain only alphabets (no spaces or numbers)" });
    }

    if (!name || name.length < 2 || name.length > 50) {
      return res.status(400).json({ error: "Room name must be 2-50 characters" });
    }

    // Rate limit: using configurable limit
    const isLimited = await checkAndIncrement(req.userId.toString(), "create_room", ROOM_LIMIT);
    if (isLimited) {
      return res.status(429).json({ error: `Daily room creation limit reached (${ROOM_LIMIT} rooms). Try again later.` });
    }

    const room = await Room.create({
      type,
      name,
      createdBy: req.userId,
      members: [req.userId],
      accessLedger: [{ userId: req.userId, joinedAt: Date.now() }],
    });

    await incrementLimit(req.userId.toString(), "create_room");

    res.status(201).json({ room });
  } catch (error) {
    console.error("Create room error:", error);
    if (error.code === 11000) {
      return res.status(400).json({ error: "Room name already exists. Please choose a unique name." });
    }
    res.status(500).json({ error: "Failed to create room" });
  }
};

/**
 * POST /api/rooms/dm
 * Create or get existing DM room between two users
 */
export const createDM = async (req, res) => {
  try {
    const { targetUserId } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ error: "Target user ID required" });
    }

    // Check target user exists and is not deleted
    const targetUser = await User.findById(targetUserId);
    if (!targetUser || targetUser.isDeleted) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if DM room already exists
    const existingRoom = await Room.findOne({
      type: "dm",
      members: { $all: [req.userId, targetUserId], $size: 2 },
    });

    if (existingRoom) {
      return res.json({ room: existingRoom });
    }

    // Create new DM room
    let room = await Room.create({
      type: "dm",
      name: undefined, // Empty name to bypass global unique constraint
      createdBy: req.userId,
      members: [req.userId, targetUserId],
      accessLedger: [
        { userId: req.userId, joinedAt: Date.now() },
        { userId: targetUserId, joinedAt: Date.now() }
      ],
    });

    room = await room.populate("members", "username isGuest isDeleted blockedUsers profilePic");

    // Notify target user if they are online
    const io = getIo();
    if (io) {
      const targetSockets = getUserSockets(targetUserId.toString());
      targetSockets.forEach((sid) => {
        io.to(sid).emit("new_dm", { room });
      });
    }

    res.status(201).json({ room });
  } catch (error) {
    console.error("Create DM error:", error);
    res.status(500).json({ error: "Failed to create DM" });
  }
};

/**
 * POST /api/rooms/:roomId/join
 * Join a room (instant for public, request for private)
 */
export const joinRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.userId;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    // Check if banned
    if (room.bannedUsers.includes(userId)) {
      return res.status(403).json({ error: "You are banned from this room" });
    }

    // Check if already a member
    if (room.members.includes(userId)) {
      return res.status(400).json({ error: "Already a member of this room" });
    }

    // Check if already pending
    if (room.pendingRequests.includes(userId)) {
      return res.status(400).json({ error: "Join request already pending" });
    }

    if (room.type === "public") {
      // Direct join
      room.members.push(userId);
      room.kickedUsers = room.kickedUsers.filter((k) => k.toString() !== userId.toString());
      room.accessLedger.push({ userId, joinedAt: Date.now() });
      await room.save();
      return res.json({ message: "Joined room successfully", room });
    }

    if (room.type === "private") {
      // Add to pending requests
      room.pendingRequests.push(userId);
      await room.save();
      
      // Notify Admin
      const io = getIo();
      if (io) {
        const adminSockets = getUserSockets(room.createdBy.toString());
        adminSockets.forEach((sid) => {
          io.to(sid).emit("new_request", { roomId, userId });
        });
      }

      return res.json({ message: "Join request sent. Waiting for admin approval." });
    }

    res.status(400).json({ error: "Cannot join this room type" });
  } catch (error) {
    console.error("Join room error:", error);
    res.status(500).json({ error: "Failed to join room" });
  }
};

/**
 * POST /api/rooms/:roomId/leave
 * Leave a room
 */
export const leaveRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.userId;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    // Admin cannot leave their own room (must delete it)
    if (room.createdBy.toString() === userId.toString()) {
      return res.status(400).json({ error: "Admin cannot leave. Delete the room instead." });
    }

    await Room.findByIdAndUpdate(roomId, {
      $pull: { members: userId },
    });

    await Room.updateOne(
      { _id: roomId, "accessLedger.userId": userId, "accessLedger.leftAt": null },
      { $set: { "accessLedger.$.leftAt": Date.now() } }
    );

    res.json({ message: "Left room successfully" });
  } catch (error) {
    console.error("Leave room error:", error);
    res.status(500).json({ error: "Failed to leave room" });
  }
};

/**
 * GET /api/rooms
 * Get all rooms the current user is a member of
 */
export const getMyRooms = async (req, res) => {
  try {
    const rooms = await Room.find({
      members: req.userId,
      hiddenBy: { $ne: req.userId }
    })
      .populate("members", "username isGuest isDeleted blockedUsers profilePic")
      .populate("kickedUsers", "username")
      .populate("bannedUsers", "username")
      .populate("createdBy", "username")
      .sort({ updatedAt: -1 });

    // For each room, get the last message
    const roomsWithLastMessage = await Promise.all(
      rooms.map(async (room) => {
        const lastMessage = await Message.findOne({ roomId: room._id })
          .sort({ createdAt: -1 })
          .populate("senderId", "username isDeleted")
          .lean();

        return {
          ...room.toObject(),
          lastMessage,
        };
      })
    );

    res.json({ rooms: roomsWithLastMessage });
  } catch (error) {
    console.error("Get my rooms error:", error);
    res.status(500).json({ error: "Failed to get rooms" });
  }
};

/**
 * GET /api/rooms/:roomId
 * Get room details
 */
export const getRoomDetails = async (req, res) => {
  try {
    const room = await Room.findById(req.params.roomId)
      .populate("members", "username isGuest isDeleted isVerified profilePic")
      .populate("pendingRequests", "username")
      .populate("bannedUsers", "username")
      .populate("createdBy", "username");

    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    res.json({ room });
  } catch (error) {
    console.error("Get room details error:", error);
    res.status(500).json({ error: "Failed to get room details" });
  }
};

/**
 * GET /api/rooms/search?name=abc
 * Search rooms by name
 */
export const searchRooms = async (req, res) => {
  try {
    const { name } = req.query;

    if (!name || name.length < 2) {
      return res.status(400).json({ error: "Search must be at least 2 characters" });
    }

    const rooms = await Room.find({
      name: { $regex: name, $options: "i" },
      type: { $in: ["public", "private"] },
    })
      .select("name type members createdBy")
      .populate("createdBy", "username")
      .limit(20);

    res.json({ rooms });
  } catch (error) {
    console.error("Search rooms error:", error);
    res.status(500).json({ error: "Room search failed" });
  }
};

// ====================== ADMIN ACTIONS ======================

/**
 * POST /api/rooms/:roomId/approve
 * Approve a join request (admin only)
 */
export const approveRequest = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId: targetUserId } = req.body;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    // Check admin
    if (room.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({ error: "Not authorized" });
    }

    // Check if user is in pending
    if (!room.pendingRequests.includes(targetUserId)) {
      return res.status(400).json({ error: "No pending request from this user" });
    }

    const updatedRoom = await Room.findByIdAndUpdate(roomId, {
      $pull: { pendingRequests: targetUserId, kickedUsers: targetUserId },
      $addToSet: { members: targetUserId },
      $push: { accessLedger: { userId: targetUserId, joinedAt: Date.now() } }
    }, { new: true }).populate("members", "username isGuest isDeleted blockedUsers profilePic").populate("createdBy", "username");

    // Notify target user
    const io = getIo();
    if (io) {
      const userSockets = getUserSockets(targetUserId.toString());
      userSockets.forEach((sid) => {
        io.to(sid).emit("request_approved", { room: updatedRoom });
      });
    }

    res.json({ message: "User approved" });
  } catch (error) {
    console.error("Approve request error:", error);
    res.status(500).json({ error: "Failed to approve request" });
  }
};

/**
 * POST /api/rooms/:roomId/reject
 * Reject a join request (admin only)
 */
export const rejectRequest = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId: targetUserId } = req.body;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    if (room.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({ error: "Not authorized" });
    }

    await Room.findByIdAndUpdate(roomId, {
      $pull: { pendingRequests: targetUserId },
    });

    res.json({ message: "Request rejected" });
  } catch (error) {
    console.error("Reject request error:", error);
    res.status(500).json({ error: "Failed to reject request" });
  }
};

/**
 * POST /api/rooms/:roomId/kick
 * Kick a user from room (admin only)
 */
export const kickUser = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId: targetUserId } = req.body;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    if (room.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({ error: "Not authorized" });
    }

    // Cannot kick admin
    if (targetUserId === room.createdBy.toString()) {
      return res.status(400).json({ error: "Cannot kick the admin" });
    }

    await Room.findByIdAndUpdate(roomId, {
      $pull: { members: targetUserId },
      $addToSet: { kickedUsers: targetUserId },
    });

    await Room.updateOne(
      { _id: roomId, "accessLedger.userId": targetUserId, "accessLedger.leftAt": null },
      { $set: { "accessLedger.$.leftAt": Date.now() } }
    );

    const io = getIo();
    if (io) {
      const targetSockets = getUserSockets(targetUserId.toString());
      targetSockets.forEach((sid) => {
        const socket = io.sockets.sockets.get(sid);
        if (socket) {
          socket.leave(roomId);
          socket.emit("kicked", { roomId });
        }
      });
      io.to(roomId).emit("user_kicked", { userId: targetUserId, roomId });
    }

    res.json({ message: "User kicked" });
  } catch (error) {
    console.error("Kick user error:", error);
    res.status(500).json({ error: "Failed to kick user" });
  }
};

/**
 * POST /api/rooms/:roomId/ban
 * Ban a user from room (admin only)
 */
export const banUser = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId: targetUserId } = req.body;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    if (room.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({ error: "Not authorized" });
    }

    if (targetUserId === room.createdBy.toString()) {
      return res.status(400).json({ error: "Cannot ban the admin" });
    }

    await Room.findByIdAndUpdate(roomId, {
      $addToSet: { bannedUsers: targetUserId },
    });

    await Room.updateOne(
      { _id: roomId, "accessLedger.userId": targetUserId, "accessLedger.leftAt": null },
      { $set: { "accessLedger.$.leftAt": Date.now() } }
    );

    const io = getIo();
    if (io) {
      const targetSockets = getUserSockets(targetUserId.toString());
      targetSockets.forEach((sid) => {
        const socket = io.sockets.sockets.get(sid);
        if (socket) {
          socket.leave(roomId);
          socket.emit("banned", { roomId });
        }
      });
      io.to(roomId).emit("user_banned", { userId: targetUserId, roomId });
    }

    res.json({ message: "User banned" });
  } catch (error) {
    console.error("Ban user error:", error);
    res.status(500).json({ error: "Failed to ban user" });
  }
};

/**
 * DELETE /api/rooms/:roomId
 * Delete a room (admin only)
 */
export const deleteRoom = async (req, res) => {
  try {
    const { roomId } = req.params;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    if (room.type !== "dm" && room.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({ error: "Not authorized" });
    }

    if (room.type === "dm" && !room.members.includes(req.userId)) {
      return res.status(403).json({ error: "Not a member of this DM" });
    }

    // Delete all messages in the room
    await Message.deleteMany({ roomId });

    // Delete the room
    await Room.findByIdAndDelete(roomId);

    // Notify all members individually using their private socket IDs
    const io = getIo();
    if (io) {
      room.members.forEach((memberId) => {
        const userSockets = getUserSockets(memberId.toString());
        userSockets.forEach((sid) => {
          io.to(sid).emit("room_deleted", { roomId });
        });
      });
      // Also broadcast to the room for those currently active within it
      io.to(roomId).emit("room_deleted", { roomId });
    }

    res.json({ message: "Room deleted" });
  } catch (error) {
    console.error("Delete room error:", error);
    res.status(500).json({ error: "Failed to delete room" });
  }
};

/**
 * PUT /api/rooms/:roomId/hide
 * Hide a room from user's list
 */
export const hideRoom = async (req, res) => {
  try {
    const { roomId } = req.params;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    await Room.findByIdAndUpdate(roomId, {
      $addToSet: { hiddenBy: req.userId }
    });

    res.json({ message: "Room hidden" });
  } catch (error) {
    console.error("Hide room error:", error);
    res.status(500).json({ error: "Failed to hide room" });
  }
};

/**
 * POST /api/rooms/:roomId/unban
 * Unban a user from room (admin only)
 */
export const unbanUser = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId: targetUserId } = req.body;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    if (room.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({ error: "Not authorized" });
    }

    await Room.findByIdAndUpdate(roomId, {
      $pull: { bannedUsers: targetUserId },
      $push: { accessLedger: { userId: targetUserId, joinedAt: Date.now() } }
    });

    const io = getIo();
    if (io) {
      const targetSockets = getUserSockets(targetUserId.toString());
      targetSockets.forEach((sid) => {
        const socket = io.sockets.sockets.get(sid);
        if (socket) {
          socket.emit("unbanned", { roomId });
        }
      });
      io.to(roomId).emit("user_unbanned", { userId: targetUserId, roomId });
    }

    res.json({ message: "User unbanned" });
  } catch (error) {
    console.error("Unban user error:", error);
    res.status(500).json({ error: "Failed to unban user" });
  }
};

/**
 * PUT /api/rooms/:roomId
 * Update room settings (admin only)
 */
export const updateRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    let { name, roomPic } = req.body;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    // Check admin
    if (room.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const updates = {};
    if (name) {
      name = sanitize(name.trim());
      if (name.length < 2 || name.length > 50) {
        return res.status(400).json({ error: "Room name must be 2-50 characters" });
      }
      updates.name = name;
    }
    if (roomPic !== undefined) {
      updates.roomPic = roomPic;
    }

    const updatedRoom = await Room.findByIdAndUpdate(
      roomId,
      { $set: updates },
      { new: true }
    )
      .populate("members", "username isGuest isDeleted blockedUsers profilePic")
      .populate("createdBy", "username");

    // Notify room members
    const io = getIo();
    if (io) {
      io.to(roomId).emit("room_updated", { room: updatedRoom });
    }

    res.json({ message: "Room updated successfully", room: updatedRoom });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: "Room name already exists" });
    }
    console.error("Update room error:", error);
    res.status(500).json({ error: "Failed to update room" });
  }
};
