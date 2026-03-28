import Message from "../models/Message.js";
import Room from "../models/Room.js";
import User from "../models/User.js";
import sanitize from "../utils/sanitize.js";
import { getIo } from "../socket/index.js";
import { deleteFile } from "./fileController.js";

/**
 * GET /api/messages/:roomId?limit=50&cursor=timestamp
 * Get messages for a room with cursor-based pagination
 */
export const getMessages = async (req, res) => {
  try {
    const { roomId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const cursor = req.query.cursor; // ISO timestamp

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    // Only allow current members to see messages
    const isMember = room.members.some(m => m.toString() === req.userId.toString());

    if (!isMember) {
      return res.status(403).json({ error: "Not a member of this room" });
    }

    // Build base query
    const baseQuery = { roomId };
    if (cursor) {
      baseQuery.createdAt = { $lt: new Date(cursor) };
    }

    const query = { $and: [baseQuery] };

    // Apply Access Ledger restricting
    const userLedgers = room.accessLedger?.filter(
      (l) => l.userId.toString() === req.userId.toString()
    ) || [];

    if (userLedgers.length > 0) {
      const allowedPeriods = userLedgers.map(ledger => {
        const periodQuery = { createdAt: { $gte: ledger.joinedAt } };
        if (ledger.leftAt) {
          periodQuery.createdAt.$lte = ledger.leftAt;
        }
        return periodQuery;
      });
      if (allowedPeriods.length > 0) {
        query.$and.push({ $or: allowedPeriods });
      }
    }

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("senderId", "username isDeleted isGuest")
      .lean();

    // Replace deleted user names
    const processedMessages = messages.map((msg) => {
      if (msg.senderId && msg.senderId.isDeleted) {
        msg.senderId.username = "Deleted User";
      }
      return msg;
    });

    // Reverse to get chronological order
    processedMessages.reverse();

    const hasMore = messages.length === limit;

    res.json({
      messages: processedMessages,
      hasMore,
      cursor: messages.length > 0 ? messages[messages.length - 1].createdAt : null,
    });
  } catch (error) {
    console.error("Get messages error:", error);
    res.status(500).json({ error: "Failed to get messages" });
  }
};

/**
 * POST /api/messages
 * Send a message (fallback — mainly handled via sockets)
 */
export const sendMessage = async (req, res) => {
  try {
    let { roomId, content, type, fileName, publicId } = req.body;

    content = sanitize(content);

    if (!roomId || !content) {
      return res.status(400).json({ error: "Room ID and content required" });
    }

    if (content.length > 5000) {
      return res.status(400).json({ error: "Message too long (max 5000 chars)" });
    }

    // Verify room access
    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    const isMember = room.members.some(
      (m) => m.toString() === req.userId.toString()
    );
    if (!isMember) {
      return res.status(403).json({ error: "Not a member of this room" });
    }

    const isKicked = room.kickedUsers?.some(
      (userId) => userId.toString() === req.userId.toString()
    );
    if (isKicked) {
      return res.status(403).json({ error: "You can no longer send messages in this room" });
    }

    // For DM rooms, check if the other user is deleted or has blocked sender
    if (room.type === "dm") {
      const otherUserId = room.members.find(
        (m) => m.toString() !== req.userId.toString()
      );
      if (otherUserId) {
        const otherUser = await User.findById(otherUserId).select("isDeleted blockedUsers");
        if (otherUser && otherUser.isDeleted) {
          return res.status(400).json({ error: "This user is no longer available" });
        }
        if (otherUser?.blockedUsers?.some(id => id.toString() === req.userId.toString())) {
          return res.status(403).json({ error: "You have been blocked by this user" });
        }
      }
    }

    const message = await Message.create({
      roomId,
      senderId: req.userId,
      content,
      type: type || "text",
      fileName,
      publicId,
    });

    const populated = await Message.findById(message._id).populate(
      "senderId",
      "username isDeleted isGuest"
    );

    res.status(201).json({ message: populated });
  } catch (error) {
    console.error("Send message error:", error);
    res.status(500).json({ error: "Failed to send message" });
  }
};

/**
 * PUT /api/messages/:messageId
 * Update a message's content (sender only)
 */
export const updateMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    let { content } = req.body;

    if (!content) {
      return res.status(400).json({ error: "Content is required" });
    }

    content = sanitize(content);

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    const room = await Room.findById(message.roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    // Check ownership
    if (message.senderId.toString() !== req.userId.toString()) {
      return res.status(403).json({ error: "Not authorized to edit this message" });
    }

    const isKicked = room.kickedUsers?.some(
      (kickedUserId) => kickedUserId.toString() === req.userId.toString()
    );

    if (isKicked) {
      return res.status(403).json({ error: "You can no longer edit messages in this room" });
    }

    // Update
    message.content = content;
    message.isEdited = true;
    await message.save();

    // Broadcast update via socket
    const io = getIo();
    if (io) {
      io.to(message.roomId.toString()).emit("message_updated", {
        messageId: message._id,
        content: message.content,
        type: message.type,
        isEdited: true,
        isDeleted: false,
      });
    }

    res.json({ message });
  } catch (error) {
    console.error("Update message error:", error);
    res.status(500).json({ error: "Failed to update message" });
  }
};

/**
 * DELETE /api/messages/:messageId
 * Delete a message (sender only)
 */
export const deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    const roomId = message.roomId.toString();
    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    if (room.type === "dm" && message.senderId.toString() !== req.userId.toString()) {
      return res.status(403).json({ error: "Not authorized to delete this message" });
    }
    
    // Check permission: sender OR room owner
    const isSender = message.senderId.toString() === req.userId.toString();
    const isRoomOwner = room.type !== "dm" && room?.createdBy?.toString() === req.userId.toString();

    if (!isSender && !isRoomOwner) {
      return res.status(403).json({ error: "Not authorized to delete this message" });
    }

    if (isSender && !isRoomOwner) {
      const isKicked = room.kickedUsers?.some(
        (kickedUserId) => kickedUserId.toString() === req.userId.toString()
      );

      if (isKicked) {
        return res.status(403).json({ error: "You can no longer delete messages in this room" });
      }
    }

    // Media cleanup if exists (with correct resourceType)
    if (message.publicId) {
      await deleteFile(message.publicId, message.resourceType || "image");
    }

    // Soft delete: keep the record but clear sensitive fields
    message.content = "Message deleted";
    message.type = "text";
    message.isDeleted = true;
    message.fileName = undefined;
    message.publicId = undefined;
    await message.save();

    // Broadcast soft-delete via socket
    const io = getIo();
    if (io) {
      io.to(roomId).emit("message_updated", { 
        messageId: message._id,
        content: message.content,
        type: message.type,
        isDeleted: true
      });
    }

    res.json({ message: "Message deleted successfully", isDeleted: true });
  } catch (error) {
    console.error("Delete message error:", error);
    res.status(500).json({ error: "Failed to delete message" });
  }
};
