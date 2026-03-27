/**
 * GET /api/config
 * Expose public-safe security and validation limits to the frontend.
 * This keeps the frontend UI (max file sizes, regex) in sync with the backend.
 */
export const getPublicConfig = async (req, res) => {
  try {
    const config = {
      // Regex patterns (sanitized for frontend usage)
      auth: {
        username: process.env.AUTH_USERNAME_REGEX || "^[a-zA-Z]+$",
        roomName: process.env.AUTH_ROOMNAME_REGEX || "^[a-zA-Z]+$",
        password: process.env.AUTH_PASSWORD_REGEX || "^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&])[A-Za-z\\d@$!%*?&]{8,}$",
      },
      // File limits
      limits: {
        avatarSize: parseInt(process.env.LIMIT_AVATAR_SIZE) || 10485760, // 10MB
        mediaSize: parseInt(process.env.LIMIT_MEDIA_SIZE) || 20971520, // 20MB
        avatarTypes: (process.env.ALLOWED_AVATAR_TYPES || "image/jpeg,image/png").split(","),
        mediaTypes: (process.env.ALLOWED_MEDIA_TYPES || "image/jpeg,image/png,image/gif,application/pdf").split(","),
      },
      // App info
      app: {
        mediaExpiryDays: parseInt(process.env.MEDIA_EXPIRY_DAYS) || 7,
      }
    };

    res.json(config);
  } catch (error) {
    console.error("Get config error:", error);
    res.status(500).json({ error: "Failed to fetch configuration" });
  }
};
