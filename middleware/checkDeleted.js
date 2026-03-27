/**
 * Middleware to block requests from deleted users.
 * Must be used AFTER verifyJWT middleware.
 */
const checkDeleted = (req, res, next) => {
  if (req.user && req.user.isDeleted) {
    return res.status(403).json({ error: "Account has been deleted" });
  }
  next();
};

export default checkDeleted;
