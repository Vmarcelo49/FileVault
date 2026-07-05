// ============================================================
// middleware/cors.js — CORS headers + OPTIONS preflight handler.
// WebDAV paths skip the OPTIONS short-circuit so the WebDAV router
// can respond with DAV: 1, 2 headers (Dolphin needs this to detect
// WebDAV support).
// ============================================================
const { isWebDAVPath } = require('./auth');

function corsHandler(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK, HEAD'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Accept, X-Idempotent, Depth, Destination, Overwrite, Timeout, Lock-Token, If'
  );
  res.setHeader('Access-Control-Max-Age', '86400');

  // Don't intercept OPTIONS for WebDAV paths — the WebDAV router needs
  // to respond with `DAV: 1, 2` headers so clients like Dolphin detect
  // support.
  if (req.method === 'OPTIONS' && !isWebDAVPath(req)) {
    return res.status(204).end();
  }
  next();
}

module.exports = corsHandler;
