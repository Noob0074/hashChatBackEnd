import express from "express";
import verifyJWT from "../middleware/auth.js";
import checkDeleted from "../middleware/checkDeleted.js";
import {
  createRoom,
  createDM,
  joinRoom,
  leaveRoom,
  getMyRooms,
  getRoomDetails,
  searchRooms,
  approveRequest,
  rejectRequest,
  kickUser,
  updateRoom,
  deleteRoom,
  hideRoom,
} from "../controllers/roomController.js";

const router = express.Router();

// All room routes require authentication
router.use(verifyJWT, checkDeleted);

// Room CRUD
router.post("/", createRoom);
router.post("/dm", createDM);
router.get("/", getMyRooms);
router.get("/search", searchRooms);
router.get("/:roomId", getRoomDetails);

// Room membership
router.post("/:roomId/join", joinRoom);
router.post("/:roomId/leave", leaveRoom);

// Admin actions
router.post("/:roomId/approve", approveRequest);
router.post("/:roomId/reject", rejectRequest);
router.post("/:roomId/kick", kickUser);
router.put("/:roomId", updateRoom);
router.delete("/:roomId", deleteRoom);
router.put("/:roomId/hide", hideRoom);

export default router;
