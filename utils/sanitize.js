import sanitizeHtml from "sanitize-html";

/**
 * Sanitize user input to prevent XSS attacks.
 * Strips all HTML tags by default.
 */
const sanitize = (input) => {
  if (typeof input !== "string") return input;
  return sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
  });
};

export default sanitize;
