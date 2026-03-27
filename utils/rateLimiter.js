import Limit from "../models/Limit.js";

/**
 * Check if a rate limit has been exceeded.
 */
export const checkLimit = async (key, action, maxCount = 5) => {
  const existing = await Limit.findOne({ key, action });
  if (!existing) return false;
  return existing.count >= maxCount;
};

/**
 * Increment the rate limit counter.
 */
export const incrementLimit = async (key, action, durationMinutes = 24 * 60) => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMinutes * 60 * 1000);

  const existing = await Limit.findOne({ key, action });
  if (existing) {
    existing.count += 1;
    existing.expiresAt = expiresAt; // Extend expiration on repeated failures
    await existing.save();
  } else {
    await Limit.create({
      key,
      action,
      count: 1,
      expiresAt,
    });
  }
};

/**
 * Check and increment a rate limit in one go.
 * @returns {boolean} true if limit was EXCEEDED
 */
export const checkAndIncrement = async (key, action, maxCount = 5, durationMinutes = 24 * 60) => {
  const isLimited = await checkLimit(key, action, maxCount);
  if (!isLimited) {
    await incrementLimit(key, action, durationMinutes);
  }
  return isLimited;
};

/**
 * Reset (delete) a rate limit counter.
 */
export const resetLimit = async (key, action) => {
  await Limit.deleteOne({ key, action });
};
