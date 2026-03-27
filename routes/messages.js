import express from "express";
import verifyJWT from "../middleware/auth.js";
import checkDeleted from "../middleware/checkDeleted.js";
import { getMessages, sendMessage, updateMessage, deleteMessage } from "../controllers/messageController.js";
 
 const router = express.Router();
 
 router.use(verifyJWT, checkDeleted);
 
 router.get("/:roomId", getMessages);
 router.post("/", sendMessage);
 router.put("/:messageId", updateMessage);
 router.delete("/:messageId", deleteMessage);

export default router;
