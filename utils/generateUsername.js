import crypto from "crypto";

/**
 * Generate a random anonymous username.
 * Format: Anon_XXXXX (5 random hex chars)
 */
const generateUsername = () => {
  const suffix = crypto.randomBytes(3).toString("hex").slice(0, 5).toUpperCase();
  return `Anon_${suffix}`;
};

export default generateUsername;
