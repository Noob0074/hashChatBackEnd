import express from "express";
import verifyJWT from "../middleware/auth.js";
import checkDeleted from "../middleware/checkDeleted.js";
import { searchUsers, getMe, updateProfile, blockUser, unblockUser } from "../controllers/userController.js";

const router = express.Router();

// All user routes require authentication
router.use(verifyJWT, checkDeleted);

router.get("/search", searchUsers);
router.get("/me", getMe);
router.put("/me", updateProfile);
router.post("/block/:userId", blockUser);
router.post("/unblock/:userId", unblockUser);

export default router;
