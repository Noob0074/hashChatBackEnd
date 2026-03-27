import express from "express";
import verifyJWT from "../middleware/auth.js";
import checkDeleted from "../middleware/checkDeleted.js";
import { getUploadUrl } from "../controllers/fileController.js";

const router = express.Router();

router.use(verifyJWT, checkDeleted);

router.post("/upload-url", getUploadUrl);

export default router;
