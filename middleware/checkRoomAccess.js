import Room from "../models/Room.js";

/**
 * Middleware to check if the authenticated user has access to a room.
 * Must be used AFTER verifyJWT middleware.
 * Expects roomId as a route parameter.
 */
const checkRoomAccess = async (req, res, next) => {
  try {
    const { roomId } = req.params;
    const userId = req.userId;

    const room = await Room.findById(roomId);

    if (!room) {
      return res.status(404).json({ error: "Room not found" });
    }

    // Check if user is a member
    const isMember = room.members.some(
      (memberId) => memberId.toString() === userId.toString()
    );

    if (!isMember) {
      return res.status(403).json({ error: "You are not a member of this room" });
    }

    // Attach room to request
    req.room = room;

    next();
  } catch (error) {
    return res.status(500).json({ error: "Failed to check room access" });
  }
};

export default checkRoomAccess;
