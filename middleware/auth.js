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

    // Check header if no cookie
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.split(" ")[1];
      }
    }

    if (!token) {
      return res.status(401).json({ error: "Unauthorized — no token provided" });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId).select("-password");
      
      if (!user || user.isDeleted) {
        return res.status(401).json({ error: "Unauthorized — account unavailable" });
      }

      req.userId = decoded.userId;
      req.user = user;
      return next();
    } catch (jwtError) {
      // If cookie failed, try the header as a last resort
      const authHeader = req.headers.authorization;
      if (req.cookies?.token && authHeader?.startsWith("Bearer ")) {
        const headerToken = authHeader.split(" ")[1];
        try {
          const decoded = jwt.verify(headerToken, process.env.JWT_SECRET);
          const user = await User.findById(decoded.userId).select("-password");
          if (user && !user.isDeleted) {
            req.userId = decoded.userId;
            req.user = user;
            return next();
          }
        } catch (innerError) {
          // both failed
        }
      }
      return res.status(401).json({ error: "Unauthorized — invalid token" });
    }
  } catch (error) {
    console.error("Auth middleware error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export default verifyJWT;
