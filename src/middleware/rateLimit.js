// ============================================================
// middleware/rateLimit.js — Simple in-memory rate limiter (per IP).
// Applied to /api/* and /upload/*. WebDAV paths are intentionally
// NOT rate-limited because clients like Dolphin make many small
// requests per navigation.
// ============================================================
const { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX } = require('../config');

const rateLimitMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    res.setHeader('Retry-After', Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
    return res.status(429).json({
      error: 'Too Many Requests',
      retryAfter: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
    });
  }
  next();
}

module.exports = rateLimit;
