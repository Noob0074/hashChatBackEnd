import jwt from "jsonwebtoken";
import User from "../models/User.js";

/**
 * Verify JWT from HTTP-only cookie or Authorization header.
 * Attaches userId and user object to req.
 */
const verifyJWT = async (req, res, next) => {
  try {
    // Try cookie first, then Authorization header
    let token = req.cookies?.token;

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.split(" ")[1];
      }
    }

    if (!token) {
      return res.status(401).json({ error: "Unauthorized — no token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.userId).select("-password");
    if (!user || user.isDeleted) {
      return res.status(401).json({ error: "Unauthorized — account unavailable" });
    }

    req.userId = decoded.userId;
    req.user = user;

    next();
  } catch (error) {
    return res.status(401).json({ error: "Unauthorized — invalid token" });
  }
};

export default verifyJWT;
