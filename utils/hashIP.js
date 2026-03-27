import crypto from "crypto";

/**
 * Hash an IP address using SHA-256.
 * Used for rate limiting and abuse detection without storing raw IPs.
 */
const hashIP = (ip) => {
  return crypto.createHash("sha256").update(ip).digest("hex");
};

export default hashIP;
