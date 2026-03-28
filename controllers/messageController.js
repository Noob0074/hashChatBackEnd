import Message from "../models/Message.js";
import Room from "../models/Room.js";
import User from "../models/User.js";
import sanitize from "../utils/sanitize.js";
import { getIo } from "../socket/index.js";
import { deleteFile } from "./fileController.js";

const MAX_MESSAGE_LENGTH = parseInt(process.env.MAX_MESSAGE_LENGTH) || 5000;
const SEARCH_LIMIT = 20;
const CONTEXT_WINDOW = 12;

const getRoomAccessQuery = (room, userId, cursor = null) => {
  const baseQuery = { roomId: room._id };
  if (cursor) {
    baseQuery.createdAt = { $lt: new Date(cursor) };
  }

  const query = { $and: [baseQuery] };

  const userLedgers =
    room.accessLedger?.filter((ledger) => ledger.userId.toString() === userId.toString()) || [];

  if (userLedgers.length > 0) {
    const allowedPeriods = userLedgers.map((ledger) => {
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

  return query;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ensureRoomMembership = (room, userId) =>
  room.members.some((memberId) => memberId.toString() === userId.toString());

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

    const query = getRoomAccessQuery(room, req.userId, cursor);

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
 * GET /api/messages/:roomId/search?q=term&cursor=timestamp
 * Search messages within a room, including text and media/file names.
 */
export const searchMessages = async (req, res) => {
  try {
    const { roomId } = req.params;
    const rawQuery = sanitize((req.query.q || "").trim());
    const limit = Math.min(parseInt(req.query.limit, 10) || SEARCH_LIMIT, 50);
    const cursor = req.query.cursor;

    if (rawQuery.length < 1) {
      return res.status(400).json({ error: "Search query is required" });
    }

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    if (!ensureRoomMembership(room, req.userId)) {
      return res.status(403).json({ error: "Not a member of this room" });
    }

    const escapedQuery = escapeRegex(rawQuery);
    const searchRegex = new RegExp(escapedQuery, "i");
    const query = getRoomAccessQuery(room, req.userId, cursor);
    const searchFilter = {
      isDeleted: { $ne: true },
      $or: [
        { content: searchRegex },
        { fileName: searchRegex },
      ],
    };
    query.$and.push(searchFilter);
    const totalQuery = getRoomAccessQuery(room, req.userId);
    totalQuery.$and.push(searchFilter);

    const [results, total] = await Promise.all([
      Message.find(query)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .populate("senderId", "username isDeleted isGuest")
        .lean(),
      Message.countDocuments(totalQuery),
    ]);

    const processedResults = results.map((msg) => {
      if (msg.senderId && msg.senderId.isDeleted) {
        msg.senderId.username = "Deleted User";
      }
      return msg;
    });

    res.json({
      results: processedResults,
      total,
      hasMore: results.length === limit,
      cursor: results.length > 0 ? results[results.length - 1].createdAt : null,
      query: rawQuery,
    });
  } catch (error) {
    console.error("Search messages error:", error);
    res.status(500).json({ error: "Failed to search messages" });
  }
};

/**
 * GET /api/messages/:roomId/context/:messageId
 * Load a small context window around a searched message.
 */
export const getMessageContext = async (req, res) => {
  try {
    const { roomId, messageId } = req.params;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    if (!ensureRoomMembership(room, req.userId)) {
      return res.status(403).json({ error: "Not a member of this room" });
    }

    const targetQuery = getRoomAccessQuery(room, req.userId);
    targetQuery.$and.push({ _id: messageId });

    const targetMessage = await Message.findOne(targetQuery)
      .populate("senderId", "username isDeleted isGuest")
      .lean();

    if (!targetMessage) {
      return res.status(404).json({ error: "Message not found" });
    }

    const baseAccessQuery = getRoomAccessQuery(room, req.userId);
    const beforeQuery = {
      $and: [...baseAccessQuery.$and, { createdAt: { $lt: targetMessage.createdAt } }],
    };
    const afterQuery = {
      $and: [...baseAccessQuery.$and, { createdAt: { $gt: targetMessage.createdAt } }],
    };

    const [before, after, olderCount] = await Promise.all([
      Message.find(beforeQuery)
        .sort({ createdAt: -1, _id: -1 })
        .limit(CONTEXT_WINDOW)
        .populate("senderId", "username isDeleted isGuest")
        .lean(),
      Message.find(afterQuery)
        .sort({ createdAt: 1, _id: 1 })
        .limit(CONTEXT_WINDOW)
        .populate("senderId", "username isDeleted isGuest")
        .lean(),
      Message.countDocuments(beforeQuery),
    ]);

    const messages = [...before.reverse(), targetMessage, ...after].map((msg) => {
      if (msg.senderId && msg.senderId.isDeleted) {
        msg.senderId.username = "Deleted User";
      }
      return msg;
    });

    res.json({
      messages,
      targetMessageId: targetMessage._id,
      hasMoreBefore: olderCount > before.length,
      cursor: messages.length > 0 ? messages[0].createdAt : null,
    });
  } catch (error) {
    console.error("Get message context error:", error);
    res.status(500).json({ error: "Failed to load message context" });
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

    if (content.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` });
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

    if (content.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` });
    }

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
