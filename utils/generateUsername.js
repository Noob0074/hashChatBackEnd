import crypto from "crypto";

/**
 * Generate a random anonymous username.
 * Format: Anon_XXXXXX (6 random hex chars)
 */
const generateUsername = () => {
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `Anon_${suffix}`;
};

export default generateUsername;
