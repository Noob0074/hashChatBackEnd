import express from "express";
import verifyJWT from "../middleware/auth.js";
import checkDeleted from "../middleware/checkDeleted.js";
import {
  getMessages,
  searchMessages,
  getMessageContext,
  sendMessage,
  updateMessage,
  deleteMessage,
} from "../controllers/messageController.js";
 
 const router = express.Router();
 
 router.use(verifyJWT, checkDeleted);
 
router.get("/:roomId/search", searchMessages);
router.get("/:roomId/context/:messageId", getMessageContext);
router.get("/:roomId", getMessages);
 router.post("/", sendMessage);
 router.put("/:messageId", updateMessage);
 router.delete("/:messageId", deleteMessage);

export default router;
