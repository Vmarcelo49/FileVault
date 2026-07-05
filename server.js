/**
 * FileVault Server v2.4.0
 * https://github.com/Vmarcelo49/FileVault
 *
 * Self-hosted file transfer server with chunked uploads, automatic
 * tunneling (Cloudflare / localtunnel / zrok), WebDAV support, and
 * a glassmorphic dark-mode web UI.
 *
 * This file is the orchestrator — all logic lives in src/. Each route
 * group is a mounted Express router; shared helpers are in src/lib/.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const {
  PORT, SHARED_DIR, CHUNK_DIR, MAX_AGE_HOURS, RATE_LIMIT_MAX,
  CHUNK_SIZE, MAX_TOTAL_SIZE,
} = require('./src/config');
const log = require('./src/log');
const { formatBytes } = require('./src/lib/files');
const corsHandler = require('./src/middleware/cors');
const rateLimit = require('./src/middleware/rateLimit');
const { startChunkCleanup } = require('./src/lib/chunks');
const { startTunnel } = require('./src/lib/tunnels');

// ============================================================
// App setup
// ============================================================
const app = express();

// Ensure shared + chunk dirs exist
if (!fs.existsSync(SHARED_DIR)) fs.mkdirSync(SHARED_DIR, { recursive: true });
if (!fs.existsSync(CHUNK_DIR)) fs.mkdirSync(CHUNK_DIR, { recursive: true });

// Middleware: request timing
app.use((req, res, next) => {
  req.startTime = Date.now();
  next();
});

// Middleware: CORS + OPTIONS preflight
app.use(corsHandler);

// Middleware: rate limiting on /api/* and /upload/*
app.use('/api/', rateLimit);
app.use('/upload', rateLimit);

// Static frontend (public/)
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir, {
    index: false,
    maxAge: 0,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      else if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=utf-8');
      else if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
      else if (filePath.endsWith('.json')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
      else if (filePath.endsWith('.svg')) res.setHeader('Content-Type', 'image/svg+xml');
    },
  }));
}

// ============================================================
// Routes — each module exports an Express Router.
// Order matters: more specific paths first, then wildcards.
// ============================================================
app.use(require('./src/routes/listing'));         // /, /ls, /api/files, /api/tree, /api/find, /api/health, /api/pwd
app.use(require('./src/routes/files'));           // /files/* (GET, DELETE)
app.use(require('./src/routes/mutations'));       // /api/write, /api/mkdir, /api/touch, /api/folders, /api/mv, /api/cp
app.use(require('./src/routes/uploadChunked'));   // /upload/chunk/*, /api/uploads
app.use(require('./src/routes/uploadSimple'));    // /upload, /upload/:path
app.use(require('./src/routes/archives'));        // /api/zip, /api/tar
app.use(require('./src/routes/metadata'));        // /api/stat, /api/du, /api/df, /api/file, /api/head, /api/tail
app.use(require('./src/routes/hashing'));         // /api/sha256, /api/md5, /api/wc
app.use(require('./src/routes/monitors'));        // /api/monitors/*

// Live view page (HTML)
const { authenticate } = require('./src/middleware/auth');
app.get('/live', authenticate, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'live.html'));
});

// ============================================================
// WebDAV — mounted at /webdav and /dav (alias)
// ============================================================
const createWebDAVRouter = require('./webdav');
const { getSafePath } = require('./src/lib/paths');
const { BLOCKLIST } = require('./src/config');
const webdavRouter = createWebDAVRouter({
  SHARED_DIR,
  getSafePath,
  authenticate,
  log,
  BLOCKLIST,
});
app.use('/webdav', webdavRouter);
app.use('/dav', webdavRouter);  // alias for shorter URLs

// ============================================================
// Start server + tunnels
// ============================================================
const server = app.listen(PORT, '0.0.0.0', () => {
  log.info(`Server listening on port ${PORT}`, { sharedDir: SHARED_DIR });
  log.info(`WebDAV endpoint active`, { mount: '/webdav', alias: '/dav' });
  log.info('Chunked upload config', {
    chunkSize: formatBytes(CHUNK_SIZE),
    maxTotalSize: formatBytes(MAX_TOTAL_SIZE),
    rateLimit: `${RATE_LIMIT_MAX} req/min`,
  });

  // Periodic cleanup of stale chunk sessions
  startChunkCleanup(MAX_AGE_HOURS);

  // Start the tunnel (Cloudflare / localtunnel / zrok based on env)
  startTunnel(PORT);
});

// ============================================================
// Graceful shutdown
// ============================================================
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    log.info('All connections closed. Exiting.');
    process.exit(0);
  });
  setTimeout(() => {
    log.warn('Forcing exit after 10s timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', { message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', { reason: String(reason) });
});
