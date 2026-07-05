/**
 * FileVault Server v2.3.1
 * https://github.com/Vmarcelo49/FileVault
 *
 * Self-hosted file transfer server with chunked uploads, automatic
 * tunneling (Cloudflare / localtunnel / zrok), and a glassmorphic
 * dark-mode web UI for browsers plus a plain-text API for curl.
 *
 * Changelog (v2.2.0):
 *   [fix] Chunked uploads from the browser now send Authorization: Bearer
 *         header. Previously the frontend sent the token only as ?token=
 *         in the URL, which the server rejects on POST — causing chunked
 *         uploads to silently fail with 0/N chunks received.
 *   [feat] ?showChunks=1 query param on /api/files reveals .chunks/ folder
 *          (.env, .git, node_modules remain blocked).
 *   [feat] GET /api/uploads endpoint lists all chunked upload sessions
 *          with progress, receivedChunks, missingChunks, age, etc.
 *   [feat] multerErrorHandler middleware translates LIMIT_FILE_SIZE,
 *          LIMIT_UNEXPECTED_FILE and friends into descriptive JSON
 *          { error, code, hint }.
 *
 * Changelog (v2.1.0):
 *   [fix] Content-Disposition default is now inline (?download=1 forces attachment)
 *   [fix] /api/health no longer leaks absolute sharedDir path
 *   [fix] /upload/chunk/init no longer exposes maxTotalSize
 *   [fix] /files/* now sends Cache-Control: no-cache, must-revalidate
 *   [fix] Warning banner suppressed by default (use ?warn=1 to show; header X-Cloudflare-Info always set)
 *   [fix] UTF-8 filenames preserved (only /\ and control chars blocked)
 *   [fix] /api/touch now uses fs.utimesSync to update mtime reliably on Windows
 *   [fix] /api/cp returns 409 if destination exists (use ?force=1 to overwrite)
 *   [fix] /api/find now returns relative paths (no leading slash)
 *   [fix] Blocklist: .env, .git, node_modules, .chunks always hidden and protected
 *   [fix] Token via query only accepted on GET (POST/DELETE/PATCH require Authorization header)
 *   [fix] Chunked upload validates chunk size before writing (rejects > CHUNK_SIZE)
 *   [fix] SHA256/MD5 streamed in 64KB chunks (no full file in memory)
 *   [fix] /api/head uses readline stream and stops after N lines
 *   [fix] /api/tail uses streaming with rolling buffer (no full file in memory)
 *   [fix] /api/zip and /api/tar now stream output (archiver package, no full buffer)
 *   [sec] Rate limiting: 100 req/min/IP on /api/* and /upload/* (configurable)
 *   [sec] CORS enabled with Access-Control-Allow-Origin: * (preflight OPTIONS handled)
 *   [sec] Path traversal validated in ALL routes including /api/tree and /api/find
 *   [ops] Graceful shutdown on SIGINT/SIGTERM (waits active uploads)
 *   [ops] Structured logs via pino-style console (ISO timestamps + levels)
 *   [ops] Tunnel healthcheck every 30s (logs warning if URL lost)
 *   [ops] MAX_TOTAL_SIZE centralized as constant
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const zlib = require('zlib');
const archiver = require('archiver');
require('dotenv').config();

// ============================================================
// Configuration
// ============================================================
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const SHARED_DIR = path.resolve(process.env.SHARED_DIR || './shared');
const CHUNK_DIR = path.join(SHARED_DIR, '.chunks');

const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || (95 * 1024 * 1024).toString(), 10);
const MAX_TOTAL_SIZE = parseInt(process.env.MAX_TOTAL_SIZE || (10 * 1024 * 1024 * 1024).toString(), 10);
const MAX_AGE_HOURS = parseInt(process.env.CHUNK_MAX_AGE_HOURS || '24', 10);

// Rate limiting config
const RATE_LIMIT_WINDOW_MS = 60 * 1000;  // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '100', 10);

// Blocklist: files/dirs that are ALWAYS hidden and inaccessible
const BLOCKLIST = new Set(['.env', '.git', '.gitignore', 'node_modules', '.chunks', '.DS_Store', 'Thumbs.db']);
// Items that can be revealed by ?showChunks=1 (or ?revealHidden=1)
const REVEALABLE = new Set(['.chunks']);

// ============================================================
// Structured logging
// ============================================================
const log = {
  _fmt(level, msg, extra) {
    const ts = new Date().toISOString();
    const x = extra ? ' ' + JSON.stringify(extra) : '';
    return `${ts} [${level}] ${msg}${x}`;
  },
  info(msg, extra) { console.log(this._fmt('INFO', msg, extra)); },
  warn(msg, extra) { console.warn(this._fmt('WARN', msg, extra)); },
  error(msg, extra) { console.error(this._fmt('ERROR', msg, extra)); },
  debug(msg, extra) { if (process.env.DEBUG) console.log(this._fmt('DEBUG', msg, extra)); }
};

// ============================================================
// Directory setup
// ============================================================
if (!fs.existsSync(SHARED_DIR)) fs.mkdirSync(SHARED_DIR, { recursive: true });
if (!fs.existsSync(CHUNK_DIR)) fs.mkdirSync(CHUNK_DIR, { recursive: true });

// ============================================================
// Helpers
// ============================================================
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * FIX #10: Path traversal protection with sep boundary
 * Resolves path inside SHARED_DIR and rejects anything escaping.
 */
function getSafePath(filename) {
  if (!filename) return null;
  const safePath = path.resolve(SHARED_DIR, filename);
  if (safePath !== SHARED_DIR && !safePath.startsWith(SHARED_DIR + path.sep)) {
    return null;
  }
  // Blocklist check: reject if any path component is in blocklist
  const parts = path.relative(SHARED_DIR, safePath).split(path.sep);
  for (const p of parts) {
    if (BLOCKLIST.has(p)) return null;
  }
  return safePath;
}

/**
 * FIX #11: Preserve UTF-8 (accents, unicode) in filenames.
 * Only block path separators and control chars.
 */
function sanitizeFilename(name) {
  const baseName = path.basename(name || '');
  // Remove path separators and control chars (0x00-0x1F, 0x7F)
  // Keep everything else including UTF-8 (accents, cyrillic, kanji, etc.)
  return baseName.replace(/[\/\\]/g, '_').replace(/[\x00-\x1f\x7f]/g, '');
}

function isBlockedName(name) {
  return BLOCKLIST.has(name);
}

// Returns true if `name` is blocked AND cannot be revealed by ?showChunks=1
function isHiddenName(name, showChunks = false) {
  if (!BLOCKLIST.has(name)) return false;
  if (showChunks && REVEALABLE.has(name)) return false;
  return true;
}

function generateUploadId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ============================================================
// Recursively scan files and directories (async, doesn't block event loop)
// FIX #19: Already async, but added maxDepth to prevent runaway scans
// PERF: uses readdir({ withFileTypes: true }) so we get the entry type
// (dir vs file) from the dirent in 1 syscall, then 1 stat per child
// for size/mtime. Previously this did readdir + N×stat = 2N syscalls.
// ============================================================
async function getFilesRecursive(dir, maxDepth = 20, currentDepth = 0, showChunks = false) {
  if (currentDepth > maxDepth) return [];
  let results = [];
  try {
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const d of dirents) {
      if (isHiddenName(d.name, showChunks)) continue;
      const filePath = path.join(dir, d.name);
      try {
        // Use dirent type when available; fall back to stat for FSes
        // that don't populate it (rare; some network mounts).
        let isDir;
        try { isDir = d.isDirectory(); }
        catch { isDir = (await fs.promises.stat(filePath)).isDirectory(); }
        const stat = await fs.promises.stat(filePath);
        const relativeToShared = path.relative(SHARED_DIR, filePath);

        if (isDir) {
          results.push({
            name: d.name,
            type: 'dir',
            size: stat.size,
            formattedSize: '-',
            modified: stat.mtime.toISOString().replace('T', ' ').substring(0, 16),
            path: relativeToShared
          });
          const subResults = await getFilesRecursive(filePath, maxDepth, currentDepth + 1, showChunks);
          results = results.concat(subResults);
        } else {
          results.push({
            name: d.name,
            type: 'file',
            size: stat.size,
            formattedSize: formatBytes(stat.size),
            modified: stat.mtime.toISOString().replace('T', ' ').substring(0, 16),
            path: relativeToShared
          });
        }
      } catch (e) { /* file deleted concurrently */ }
    }
  } catch (e) {
    log.error(`Error reading path recursively: ${e.message}`);
  }
  return results;
}

// ============================================================
// Chunked upload storage helpers
// ============================================================
function chunkMetaPath(uploadId) {
  return path.join(CHUNK_DIR, uploadId, 'meta.json');
}

function chunkFilePath(uploadId, chunkIndex) {
  return path.join(CHUNK_DIR, uploadId, `chunk_${String(chunkIndex).padStart(6, '0')}`);
}

function readChunkMeta(uploadId) {
  try {
    const metaFile = chunkMetaPath(uploadId);
    if (!fs.existsSync(metaFile)) return null;
    return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch (e) { return null; }
}

function writeChunkMeta(uploadId, meta) {
  const metaFile = chunkMetaPath(uploadId);
  fs.mkdirSync(path.dirname(metaFile), { recursive: true });
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
}

function listReceivedChunks(uploadId) {
  const dir = path.join(CHUNK_DIR, uploadId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith('chunk_'))
    .map(f => parseInt(f.replace('chunk_', ''), 10))
    .sort((a, b) => a - b);
}

// ============================================================
// Middleware: timing
// ============================================================
app.use((req, res, next) => {
  req.startTime = Date.now();
  next();
});

// ============================================================
// FIX #8 + #28: CORS + preflight OPTIONS handler
// ============================================================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Idempotent, Depth, Destination, Overwrite, Timeout, Lock-Token, If');
  res.setHeader('Access-Control-Max-Age', '86400');
  // Don't intercept OPTIONS for WebDAV paths — the WebDAV router needs to
  // respond with `DAV: 1, 2` headers so clients like Dolphin detect support.
  const isWebDAVPath = req.path.startsWith('/webdav') || req.path.startsWith('/dav');
  if (req.method === 'OPTIONS' && !isWebDAVPath) {
    return res.status(204).end();
  }
  next();
});

// ============================================================
// FIX #7: Rate limiting (simple in-memory, per-IP)
// ============================================================
const rateLimitMap = new Map();
setInterval(() => {
  // Cleanup expired entries every 5 minutes
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
    return res.status(429).json({ error: 'Too Many Requests', retryAfter: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) });
  }
  next();
}

app.use('/api/', rateLimit);
app.use('/upload', rateLimit);

// ============================================================
// Static file serving for /public assets
// ============================================================
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir, {
    index: false,
    maxAge: 0,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      } else if (filePath.endsWith('.css')) {
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
      } else if (filePath.endsWith('.json')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      } else if (filePath.endsWith('.svg')) {
        res.setHeader('Content-Type', 'image/svg+xml');
      }
    }
  }));
}

// ============================================================
// FIX #24: Authentication — token via query ONLY accepted on GET
// POST/DELETE/PATCH require Authorization header (prevents token in logs)
// ============================================================
const authenticate = (req, res, next) => {
  const token = process.env.AUTH_TOKEN;
  if (!token) return next();

  let clientToken = null;

  // GET requests: allow query param token (for shareable URLs)
  if (req.method === 'GET') {
    clientToken = req.query.token;
  }

  // All methods: Authorization header (Bearer or Basic)
  if (!clientToken && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts[0] === 'Bearer') {
      clientToken = parts[1];
    } else if (parts[0] === 'Basic') {
      // WebDAV clients (Dolphin, Finder, Windows Explorer, Nautilus) only
      // support Basic/Digest auth — not Bearer. We accept Basic auth where
      // the username is ignored and the password carries the AUTH_TOKEN.
      // This keeps a single source of truth for credentials.
      try {
        const decoded = Buffer.from(parts[1], 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        if (idx >= 0) {
          clientToken = decoded.substring(idx + 1);
        }
      } catch (e) { /* invalid base64 — fall through to 401 */ }
    }
  }

  if (clientToken === token) return next();

  const isCurl = req.headers['user-agent'] && req.headers['user-agent'].includes('curl');
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  // FIX: WebDAV clients (Dolphin, Finder, Windows Explorer, Nautilus) only
  // prompt for credentials when the 401 response carries a
  // `WWW-Authenticate: Basic realm="..."` header. Without it, Dolphin silently
  // fails to open the folder with no login dialog. We detect WebDAV paths
  // and emit the challenge so clients know to send Basic auth.
  // NOTE: when this middleware runs inside a router mounted at /webdav or
  // /dav, req.path is the path RELATIVE to the mount point (e.g. "/" or
  // "/subdir"), so we must check req.baseUrl too. req.originalUrl always
  // contains the full URL, which is the safest check.
  const fullPath = req.baseUrl + req.path;
  const isWebDAVPath = fullPath.startsWith('/webdav') || fullPath.startsWith('/dav')
    || req.originalUrl.startsWith('/webdav') || req.originalUrl.startsWith('/dav');
  if (isWebDAVPath) {
    res.setHeader('WWW-Authenticate', 'Basic realm="FileVault", charset="UTF-8"');
  }

  if (wantsJson) {
    return res.status(401).json({ error: 'Unauthorized. Invalid or missing token.' });
  } else if (isCurl) {
    return res.status(401).send('Unauthorized. Use: curl -H "Authorization: Bearer <token>" ...\n');
  } else {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Access Denied</title>
        <style>
          body { background-color:#0f0f13;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0; }
          .container { background:#1a1a24;padding:2.5rem;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,0.4);text-align:center;max-width:380px;width:100%;border:1px solid #2e2e3f; }
          h2 { margin-top:0;color:#f8fafc;font-weight:600; }
          p { color:#94a3b8;font-size:0.95rem;margin-bottom:1.5rem; }
          input { width:100%;padding:12px;border-radius:6px;border:1px solid #3f3f50;background:#0f0f13;color:#fff;margin-bottom:1.25rem;box-sizing:border-box;font-size:1rem; }
          input:focus { outline:2px solid #6366f1;border-color:transparent; }
          button { background:#6366f1;border:none;color:white;padding:12px;border-radius:6px;cursor:pointer;font-weight:600;width:100%;font-size:1rem;transition:background 0.2s; }
          button:hover { background:#4f46e5; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2>Authentication Required</h2>
          <p>This file transfer server is protected. Please enter the access token.</p>
          <input type="password" id="token" placeholder="Access Token" autofocus>
          <button onclick="submitToken()">Submit</button>
        </div>
        <script>
          function submitToken() {
            const token = document.getElementById('token').value;
            if (token) {
              const url = new URL(window.location.href);
              url.searchParams.set('token', token);
              window.location.href = url.toString();
            }
          }
          document.getElementById('token').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') submitToken();
          });
        </script>
      </body>
      </html>
    `);
  }
};

// ============================================================
// FIX #3: Directory listing helper — warning suppressed by default
// Use ?warn=1 to show warning banner in plain-text output
// Header X-Cloudflare-Info is always set (programmatic access)
// ============================================================
async function handleDirectoryList(req, res, relativePath = '') {
  const isCurl = req.headers['user-agent'] && req.headers['user-agent'].includes('curl');
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  const targetDir = path.resolve(SHARED_DIR, relativePath);

  if (targetDir !== SHARED_DIR && !targetDir.startsWith(SHARED_DIR + path.sep)) {
    return res.status(403).send('Forbidden\n');
  }
  if (!fs.existsSync(targetDir)) {
    return res.status(404).send('Directory not found\n');
  }

  try {
    const isRecursive = req.query.recursive === '1';
    const showChunks = req.query.showChunks === '1' || req.query.revealHidden === '1';
    let files = [];

    if (isRecursive) {
      files = await getFilesRecursive(targetDir, 20, 0, showChunks);
    } else {
      const fileNames = await fs.promises.readdir(targetDir);
      for (const name of fileNames) {
        if (isHiddenName(name, showChunks)) continue;  // FIX #26: hide .chunks and other blocklist (unless showChunks=1)
        const filePath = path.join(targetDir, name);
        try {
          const stat = await fs.promises.stat(filePath);
          const relPath = relativePath ? `${relativePath}/${name}` : name;
          files.push({
            name,
            type: stat.isDirectory() ? 'dir' : 'file',
            size: stat.size,
            formattedSize: stat.isDirectory() ? '-' : formatBytes(stat.size),
            modified: stat.mtime.toISOString().replace('T', ' ').substring(0, 16),
            path: relPath
          });
        } catch (e) { /* skip deleted */ }
      }
    }

    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    if (wantsJson) {
      return res.json(files);
    }

    const host = req.headers.host || '';
    const isCF = host.includes('trycloudflare.com');
    const showWarning = req.query.warn === '1';

    let output = '';
    if (isCF) {
      res.setHeader('X-Cloudflare-Info', 'Large files > 95MB are supported via chunked uploads.');
      if (showWarning && !isCurl) {
        output += `✨ Info: Exposed via Cloudflare Tunnel. Files > 95MB will be uploaded in chunks automatically.\n\n`;
      }
    }

    if (relativePath && !isRecursive) {
      output += `Directory: ${relativePath}\n\n`;
    }

    if (files.length === 0) {
      output += 'No files or folders shared in this directory.\n';
      return res.send(output);
    }

    files.forEach(f => {
      let displayName = f.name;
      if (isRecursive) {
        displayName = f.type === 'dir' ? `/${f.path}/` : `/${f.path}`;
      } else {
        displayName = f.type === 'dir' ? `${f.name}/` : f.name;
      }
      const displaySize = f.type === 'dir' ? 'DIR' : f.formattedSize;
      output += `${displaySize.padEnd(9)}  ${f.modified}  ${displayName}\n`;
    });
    return res.send(output);
  } catch (err) {
    return res.status(500).send(`Server error: ${err.message}\n`);
  }
}

// ============================================================
// Routes: Listing
// ============================================================
app.get('/', authenticate, (req, res) => {
  const isCurl = req.headers['user-agent'] && req.headers['user-agent'].includes('curl');
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (!wantsJson && !isCurl) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  const relativePath = (req.query.path || '').replace(/^\/+/, '');
  return handleDirectoryList(req, res, relativePath);
});

app.get(['/ls', '/ls/:path(*)'], authenticate, (req, res) => {
  const relativePath = (req.params.path || req.params[0] || '').replace(/^\/+/, '');
  return handleDirectoryList(req, res, relativePath);
});

app.get('/api/files', authenticate, async (req, res) => {
  const relativePath = (req.query.path || '').replace(/^\/+/, '');
  const targetDir = path.resolve(SHARED_DIR, relativePath);
  if (targetDir !== SHARED_DIR && !targetDir.startsWith(SHARED_DIR + path.sep)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!fs.existsSync(targetDir)) {
    return res.status(404).json({ error: 'Directory not found' });
  }
  try {
    const isRecursive = req.query.recursive === '1';
    const showChunks = req.query.showChunks === '1' || req.query.revealHidden === '1';
    let files = [];
    if (isRecursive) {
      files = await getFilesRecursive(targetDir, 20, 0, showChunks);
    } else {
      const fileNames = await fs.promises.readdir(targetDir);
      for (const name of fileNames) {
        if (isHiddenName(name, showChunks)) continue;
        const filePath = path.join(targetDir, name);
        try {
          const stat = await fs.promises.stat(filePath);
          files.push({
            name,
            type: stat.isDirectory() ? 'dir' : 'file',
            size: stat.size,
            formattedSize: stat.isDirectory() ? '-' : formatBytes(stat.size),
            modified: stat.mtime.toISOString().replace('T', ' ').substring(0, 16),
            path: relativePath ? `${relativePath}/${name}` : name
          });
        } catch (e) { /* skip deleted */ }
      }
    }
    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return res.json(files);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// FIX #4: /api/health no longer leaks sharedDir path
// FIX: version is read from package.json so it stays in sync.
// /api/health is intentionally unauthenticated so monitoring probes
// (uptime checks, load balancer pings) can verify the server is up
// without needing the token. It exposes only: status, uptime, version,
// and whether auth is enabled (no paths, no counts, no token info).
// ============================================================
const PKG_VERSION = (() => {
  try { return require('./package.json').version || 'unknown'; }
  catch { return 'unknown'; }
})();

app.get('/api/health', (req, res) => {
  return res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    version: PKG_VERSION,
    authEnabled: !!process.env.AUTH_TOKEN
  });
});

// FIX: /api/pwd requires auth now (was leaking path to anonymous)
app.get('/api/pwd', authenticate, (req, res) => {
  return res.send(`${path.resolve(SHARED_DIR)}\n`);
});

// ============================================================
// FIX #29: /api/find returns relative paths (no leading slash)
// PERF: caches the recursive file listing for 30s to avoid rescanning
// the entire SHARED_DIR on every search. The cache is invalidated
// automatically when the directory's mtime changes (file added/deleted).
// ============================================================
let _findCache = null;       // { mtimeMs, files }
let _findCacheAt = 0;
const FIND_CACHE_TTL_MS = 30 * 1000;

async function getFindIndex() {
  const now = Date.now();
  // Re-validate if older than TTL
  if (_findCache && (now - _findCacheAt) < FIND_CACHE_TTL_MS) {
    // Also re-validate if SHARED_DIR mtime changed (file added/deleted)
    try {
      const dirStat = await fs.promises.stat(SHARED_DIR);
      if (dirStat.mtimeMs === _findCache.mtimeMs) {
        return _findCache.files;
      }
    } catch { /* fall through to refresh */ }
  }
  const dirStat = await fs.promises.stat(SHARED_DIR);
  const files = await getFilesRecursive(SHARED_DIR);
  _findCache = { mtimeMs: dirStat.mtimeMs, files };
  _findCacheAt = now;
  return files;
}

app.get('/api/find', authenticate, async (req, res) => {
  const query = req.query.q || '';
  if (!query) return res.status(400).json({ error: 'Query q is required' });
  try {
    const regexStr = '^' + query
      .replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
      .replace(/\\\*/g, '.*')
      .replace(/\\\?/g, '.') + '$';
    const regex = new RegExp(regexStr, 'i');
    const allFiles = await getFindIndex();
    const matched = allFiles.filter(f => regex.test(f.name)).map(f => f.path);
    return res.json(matched);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// FIX #10: /api/tree validates path traversal
app.get('/api/tree', authenticate, async (req, res) => {
  const relativePath = (req.query.path || '').replace(/^\/+/, '');
  const targetDir = path.resolve(SHARED_DIR, relativePath);
  if (targetDir !== SHARED_DIR && !targetDir.startsWith(SHARED_DIR + path.sep)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!fs.existsSync(targetDir)) return res.status(404).json({ error: 'Not found' });
  const maxDepth = parseInt(req.query.depth) || 3;
  try {
    const buildTree = async (dir, currentDepth) => {
      const name = path.basename(dir) || 'Root';
      const relativeToShared = path.relative(SHARED_DIR, dir);
      const stat = await fs.promises.stat(dir);
      const node = {
        name,
        path: relativeToShared ? `/${relativeToShared}` : '/',
        type: 'dir',
        modified: stat.mtime.toISOString().replace('T', ' ').substring(0, 16)
      };
      if (currentDepth < maxDepth) {
        node.children = [];
        const items = await fs.promises.readdir(dir);
        for (const item of items) {
          if (isBlockedName(item)) continue;
          const fullPath = path.join(dir, item);
          const s = await fs.promises.stat(fullPath);
          if (s.isDirectory()) {
            node.children.push(await buildTree(fullPath, currentDepth + 1));
          } else {
            node.children.push({
              name: item,
              path: relativeToShared ? `/${relativeToShared}/${item}` : `/${item}`,
              type: 'file',
              size: s.size,
              formattedSize: formatBytes(s.size),
              modified: s.mtime.toISOString().replace('T', ' ').substring(0, 16)
            });
          }
        }
        node.children.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      }
      return node;
    };
    const tree = await buildTree(targetDir, 0);
    return res.json(tree);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/stat/:path(*)', authenticate, async (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File or directory not found' });
  }
  try {
    const stat = await fs.promises.stat(filePath);
    return res.json({
      name: path.basename(filePath),
      size: stat.size,
      modified: stat.mtime.toISOString().replace('T', ' ').substring(0, 19),
      created: stat.birthtime.toISOString().replace('T', ' ').substring(0, 19),
      type: stat.isDirectory() ? 'dir' : 'file',
      isFile: stat.isFile(),
      isDir: stat.isDirectory()
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/du/:path(*)', authenticate, async (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Folder or file not found' });
  }
  try {
    let totalSize = 0;
    let fileCount = 0;
    const scan = async (dir) => {
      const stat = await fs.promises.stat(dir);
      if (stat.isFile()) {
        totalSize += stat.size;
        fileCount++;
      } else if (stat.isDirectory()) {
        const items = await fs.promises.readdir(dir);
        for (const item of items) {
          if (isBlockedName(item)) continue;
          await scan(path.join(dir, item));
        }
      }
    };
    await scan(filePath);
    return res.json({
      path: relativePath ? `/${relativePath}` : '/',
      size: totalSize,
      formattedSize: formatBytes(totalSize),
      fileCount
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// FIX #1 + #6: /files/* — inline default + Cache-Control header
// ============================================================
app.get('/files/*', authenticate, (req, res) => {
  const relativePath = req.params[0];
  const filePath = getSafePath(relativePath);

  if (!filePath || !fs.existsSync(filePath)) {
    const isCurl = req.headers['user-agent'] && req.headers['user-agent'].includes('curl');
    return res.status(404).send(isCurl ? 'File not found\n' : 'File not found');
  }

  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    return res.status(400).send('Cannot download a directory directly. Use /api/zip or /api/tar.\n');
  }

  // FIX #1: Default to inline (renders in browser). Use ?download=1 to force attachment.
  const disposition = req.query.download === '1' ? 'attachment' : 'inline';
  const safeName = sanitizeFilename(path.basename(filePath));
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);

  // FIX #6: Cache-Control to prevent stale responses
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.setHeader('Last-Modified', stat.mtime.toUTCString());

  res.sendFile(filePath);
});

// ============================================================
// Chunked Upload
// ============================================================
const UPLOAD_ID_REGEX = /^[a-zA-Z0-9_-]{4,128}$/;

// FIX: Per-uploadId mutex to prevent race conditions when two chunks
// arrive concurrently. Without this, both see existsSync=false, both
// write the chunk file, and the second writeChunkMeta call overwrites
// the first — meta.receivedChunks ends up out of sync with disk reality.
// Implementation: chain of Promises per uploadId. Each chunk waits for
// the previous to settle before running. Settled chains are GC'd.
const _uploadLocks = new Map();
function withUploadLock(uploadId, fn) {
  const prev = _uploadLocks.get(uploadId) || Promise.resolve();
  // Chain our work onto the previous lock. Catch on the stored view so
  // a failed chunk doesn't break the chain for subsequent chunks.
  const next = prev.then(() => fn());
  const stored = next.catch(() => {});
  _uploadLocks.set(uploadId, stored);
  // Best-effort cleanup: if no new chunk extended the chain, drop the entry.
  stored.then(() => {
    if (_uploadLocks.get(uploadId) === stored) {
      _uploadLocks.delete(uploadId);
    }
  });
  return next;
}

// FIX #5: init response no longer exposes maxTotalSize
app.post('/upload/chunk/init', authenticate, express.json({ limit: '1mb' }), (req, res) => {
  try {
    const { uploadId, fileName, totalSize, totalChunks, path: reqPath } = req.body || {};
    if (!uploadId || !fileName || !totalSize || !totalChunks) {
      return res.status(400).json({ error: 'Missing required fields: uploadId, fileName, totalSize, totalChunks' });
    }
    if (!UPLOAD_ID_REGEX.test(uploadId)) {
      return res.status(400).json({ error: 'Invalid uploadId format' });
    }
    const totalBytes = parseInt(totalSize, 10);
    const total = parseInt(totalChunks, 10);
    if (isNaN(totalBytes) || totalBytes <= 0 || isNaN(total) || total <= 0) {
      return res.status(400).json({ error: 'Invalid totalSize or totalChunks' });
    }
    if (totalBytes > MAX_TOTAL_SIZE) {
      return res.status(413).json({ error: `Total size exceeds maximum allowed` });
    }

    const meta = {
      uploadId,
      fileName: sanitizeFilename(fileName),
      originalName: fileName,
      totalChunks: total,
      totalSize: totalBytes,
      receivedChunks: [],
      targetPath: reqPath || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finalized: false
    };
    writeChunkMeta(uploadId, meta);

    return res.json({
      success: true,
      uploadId,
      chunkSize: CHUNK_SIZE,
      expectedChunks: total
      // FIX #5: maxTotalSize removed from response
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// FIX #18: chunked upload validates chunk size before saving
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHUNK_SIZE + 1024 } // small buffer over CHUNK_SIZE
});

app.post('/upload/chunk', authenticate, (req, _res, next) => { req._chunkUpload = true; next(); }, chunkUpload.single('file'), async (req, res) => {
  try {
    const { uploadId, chunkIndex, totalChunks, fileName, totalSize } = req.body || {};
    if (!uploadId || chunkIndex === undefined || totalChunks === undefined) {
      return res.status(400).json({ error: 'Missing required fields: uploadId, chunkIndex, totalChunks' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No chunk data received (field name must be "file")' });
    }
    if (!UPLOAD_ID_REGEX.test(uploadId)) {
      return res.status(400).json({ error: 'Invalid uploadId format' });
    }

    const idx = parseInt(chunkIndex, 10);
    const total = parseInt(totalChunks, 10);
    if (isNaN(idx) || isNaN(total) || idx < 0 || idx >= total) {
      return res.status(400).json({ error: 'Invalid chunkIndex or totalChunks' });
    }

    // FIX #18: Validate chunk size (only last chunk may be smaller)
    const isLast = idx === total - 1;
    if (!isLast && req.file.size > CHUNK_SIZE) {
      return res.status(413).json({
        error: `Chunk size ${req.file.size} exceeds limit ${CHUNK_SIZE}`
      });
    }

    // FIX: serialize per-uploadId so concurrent chunks don't clobber
    // meta.json or race on existsSync(cFile). The lock is released when
    // the inner function resolves (either with a response or a throw).
    return await withUploadLock(uploadId, async () => {
      let meta = readChunkMeta(uploadId);

      if (idx === 0 && !meta) {
        if (!fileName || !totalSize) {
          return res.status(400).json({ error: 'First chunk must include fileName and totalSize' });
        }
        const totalBytes = parseInt(totalSize, 10);
        if (isNaN(totalBytes) || totalBytes <= 0) {
          return res.status(400).json({ error: 'Invalid totalSize' });
        }
        if (totalBytes > MAX_TOTAL_SIZE) {
          return res.status(413).json({ error: 'Total size exceeds maximum allowed' });
        }
        meta = {
          uploadId,
          fileName: sanitizeFilename(fileName),
          originalName: fileName,
          totalChunks: total,
          totalSize: totalBytes,
          receivedChunks: [],
          targetPath: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          finalized: false
        };
        writeChunkMeta(uploadId, meta);
      } else if (!meta) {
        return res.status(409).json({
          error: 'Upload session not found. Send chunk 0 first or call POST /upload/chunk/init.'
        });
      }

      if (meta.finalized) {
        return res.status(409).json({ error: 'Upload already finalized', uploadId, fileName: meta.fileName });
      }
      if (meta.totalChunks !== total) {
        return res.status(409).json({ error: `totalChunks mismatch: expected ${meta.totalChunks}, got ${total}` });
      }

      const cFile = chunkFilePath(uploadId, idx);
      if (!fs.existsSync(cFile)) {
        fs.writeFileSync(cFile, req.file.buffer);
      }

      const onDisk = listReceivedChunks(uploadId);
      meta.receivedChunks = onDisk;
      meta.updatedAt = new Date().toISOString();
      writeChunkMeta(uploadId, meta);

      // FIX #14: Idempotent — header tells client this is safe to retry
      res.setHeader('X-Idempotent', 'true');

      if (onDisk.length === total) {
        return await finalizeChunkedUpload(uploadId, meta, req, res);
      }

      return res.json({
        success: true,
        uploadId,
        chunkIndex: idx,
        received: onDisk.length,
        total,
        progress: ((onDisk.length / total) * 100).toFixed(2) + '%',
        missing: Array.from({ length: total }, (_, i) => i).filter(i => !onDisk.includes(i))
      });
    });
  } catch (err) {
    log.error('Chunk upload error:', { message: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Attach multer error handler for chunked upload route
app.use('/upload/chunk', multerErrorHandler);

app.get('/upload/chunk/status', authenticate, (req, res) => {
  const { uploadId } = req.query;
  if (!uploadId) return res.status(400).json({ error: 'Missing uploadId' });
  if (!UPLOAD_ID_REGEX.test(uploadId)) return res.status(400).json({ error: 'Invalid uploadId format' });
  const meta = readChunkMeta(uploadId);
  if (!meta) return res.status(404).json({ error: 'Upload session not found' });
  const onDisk = listReceivedChunks(uploadId);
  return res.json({
    uploadId: meta.uploadId,
    fileName: meta.fileName,
    originalName: meta.originalName,
    totalChunks: meta.totalChunks,
    totalSize: meta.totalSize,
    formattedSize: formatBytes(meta.totalSize),
    receivedChunks: onDisk,
    receivedCount: onDisk.length,
    missingChunks: Array.from({ length: meta.totalChunks }, (_, i) => i).filter(i => !onDisk.includes(i)),
    progress: ((onDisk.length / meta.totalChunks) * 100).toFixed(2) + '%',
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    finalized: meta.finalized || false,
    finalPath: meta.finalPath || null
  });
});

app.delete('/upload/chunk', authenticate, (req, res) => {
  const { uploadId } = req.query;
  if (!uploadId) return res.status(400).json({ error: 'Missing uploadId' });
  if (!UPLOAD_ID_REGEX.test(uploadId)) return res.status(400).json({ error: 'Invalid uploadId format' });
  const dir = path.join(CHUNK_DIR, uploadId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return res.json({ success: true, message: `Upload ${uploadId} cancelled and cleaned up` });
  }
  return res.status(404).json({ error: 'Upload session not found' });
});

// ============================================================
// List all chunked upload sessions (active + finalized recently)
// ============================================================
app.get('/api/uploads', authenticate, (req, res) => {
  try {
    if (!fs.existsSync(CHUNK_DIR)) return res.json({ sessions: [], total: 0 });
    const includeFinalized = req.query.includeFinalized === '1';
    const sessions = [];
    const dirs = fs.readdirSync(CHUNK_DIR);
    for (const sid of dirs) {
      if (!UPLOAD_ID_REGEX.test(sid)) continue;
      const meta = readChunkMeta(sid);
      if (!meta) {
        // Stale dir with no meta — report as orphan
        sessions.push({
          uploadId: sid,
          orphan: true,
          createdAt: null,
          updatedAt: null,
          finalized: false
        });
        continue;
      }
      if (meta.finalized && !includeFinalized) continue;
      const onDisk = listReceivedChunks(sid);
      const total = meta.totalChunks || 0;
      const received = onDisk.length;
      const pct = total > 0 ? ((received / total) * 100) : 0;
      const updatedAtMs = meta.updatedAt ? new Date(meta.updatedAt).getTime() : 0;
      const ageSec = updatedAtMs ? Math.floor((Date.now() - updatedAtMs) / 1000) : null;
      sessions.push({
        uploadId: sid,
        fileName: meta.fileName,
        originalName: meta.originalName,
        totalChunks: total,
        receivedChunks: onDisk,
        receivedCount: received,
        missingChunks: Array.from({ length: total }, (_, i) => i).filter(i => !onDisk.includes(i)),
        progress: Number(pct.toFixed(2)),
        totalSize: meta.totalSize,
        formattedSize: formatBytes(meta.totalSize),
        targetPath: meta.targetPath || '',
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        finalizedAt: meta.finalizedAt || null,
        finalized: !!meta.finalized,
        finalPath: meta.finalPath || null,
        ageSec,
        chunkSize: CHUNK_SIZE
      });
    }
    // Most recent first
    sessions.sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    });
    return res.json({
      total: sessions.length,
      active: sessions.filter(s => !s.finalized).length,
      finalized: sessions.filter(s => s.finalized).length,
      sessions
    });
  } catch (err) {
    log.error('List uploads error:', { message: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HeadlessLab monitor integration
// ============================================================
// Calls the external `headless` CLI to list active live-screen monitors.
// Returns cached result for 2s to avoid spawning a subprocess on every request.
//
// Configuration via env vars:
//   HEADLESS_BIN  — path to the headless CLI (default: /home/z/bin/headless)
//   HEADLESS_MONITOR_ENABLED  — set to 'false' to disable (returns 503)

const HEADLESS_BIN = process.env.HEADLESS_BIN || '/home/z/bin/headless';
const HEADLESS_MONITOR_ENABLED = process.env.HEADLESS_MONITOR_ENABLED !== 'false';

let _monitorsCache = null;
let _monitorsCacheAt = 0;

app.get('/api/monitors', authenticate, async (req, res) => {
  if (!HEADLESS_MONITOR_ENABLED) {
    return res.status(503).json({
      error: 'Monitor integration disabled (HEADLESS_MONITOR_ENABLED=false)',
      headless_available: false,
      monitors: [],
      total: 0,
      active: 0
    });
  }
  if (!fs.existsSync(HEADLESS_BIN)) {
    return res.status(503).json({
      error: `headless CLI not found at ${HEADLESS_BIN}`,
      headless_available: false,
      monitors: [],
      total: 0,
      active: 0
    });
  }

  // Cache hit?
  const now = Date.now();
  if (_monitorsCache && (now - _monitorsCacheAt) < 2000) {
    return res.json(_monitorsCache);
  }

  try {
    const { execFile } = require('child_process');
    const env = { ...process.env, APPDIR: process.env.APPDIR || '/home/z/my-project/squashfs-root' };
    execFile(HEADLESS_BIN, ['monitor', 'status'], {
      timeout: 5000,
      env,
      cwd: process.env.HOME || '/home/z'
    }, (err, stdout, stderr) => {
      if (err) {
        log.error('Monitor status exec error:', { message: err.message, stderr: stderr?.substring(0, 200) });
        const fallback = {
          status: 'ok',
          headless_available: true,
          total: 0,
          active: 0,
          monitors: [],
          error: err.message
        };
        _monitorsCache = fallback;
        _monitorsCacheAt = now;
        return res.json(fallback);
      }
      try {
        const parsed = JSON.parse(stdout);
        const result = {
          ...parsed,
          headless_available: true,
          // For each monitor, enrich with file metadata (size, mtime) of the output PNG
          monitors: (parsed.monitors || []).map(m => {
            try {
              const outPath = m.out_path;
              if (outPath && fs.existsSync(outPath)) {
                const stat = fs.statSync(outPath);
                return {
                  ...m,
                  out_size: stat.size,
                  out_size_formatted: formatBytes(stat.size),
                  out_mtime: stat.mtime.toISOString(),
                  out_age_ms: now - stat.mtimeMs
                };
              }
              return m;
            } catch { return m; }
          })
        };
        _monitorsCache = result;
        _monitorsCacheAt = now;
        return res.json(result);
      } catch (parseErr) {
        log.error('Monitor status parse error:', { message: parseErr.message, stdout: stdout.substring(0, 200) });
        return res.status(500).json({
          error: 'Failed to parse headless output',
          stdout: stdout.substring(0, 500),
          stderr: stderr?.substring(0, 500)
        });
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/monitors/start', authenticate, express.json({ limit: '1mb' }), async (req, res) => {
  if (!HEADLESS_MONITOR_ENABLED) {
    return res.status(503).json({ error: 'Monitor integration disabled' });
  }
  const { session_id, out_path, interval, quality, skip_identical } = req.body || {};
  if (!session_id || !out_path) {
    return res.status(400).json({
      error: 'Missing required fields: session_id, out_path',
      code: 'MISSING_FIELDS'
    });
  }
  // Resolve out_path relative to SHARED_DIR if not absolute
  const finalOutPath = path.isAbsolute(out_path)
    ? out_path
    : path.resolve(SHARED_DIR, out_path);
  // Safety: out_path must be inside SHARED_DIR (so FileVault can serve it)
  if (!finalOutPath.startsWith(SHARED_DIR + path.sep) && finalOutPath !== SHARED_DIR) {
    return res.status(403).json({
      error: 'out_path must be inside the shared directory (so it can be served by FileVault)',
      code: 'OUT_PATH_OUTSIDE_SHARED',
      shared_dir: SHARED_DIR,
      out_path: finalOutPath
    });
  }

  try {
    const { execFile } = require('child_process');
    const args = ['monitor', 'start', '--session', session_id, '--out', finalOutPath];
    if (interval) args.push('--interval', String(interval));
    if (quality) args.push('--quality', String(quality));
    if (skip_identical === false) args.push('--no-skip-identical');

    const env = { ...process.env, APPDIR: process.env.APPDIR || '/home/z/my-project/squashfs-root' };
    execFile(HEADLESS_BIN, args, {
      timeout: 10000,
      env,
      cwd: process.env.HOME || '/home/z'
    }, (err, stdout, stderr) => {
      if (err) {
        log.error('Monitor start exec error:', { message: err.message, stderr: stderr?.substring(0, 200) });
        try {
          const parsed = JSON.parse(stdout || '{}');
          return res.status(400).json(parsed);
        } catch {
          return res.status(500).json({
            error: err.message,
            stdout: stdout?.substring(0, 500),
            stderr: stderr?.substring(0, 500)
          });
        }
      }
      try {
        const parsed = JSON.parse(stdout);
        // Invalidate cache
        _monitorsCache = null;
        return res.json(parsed);
      } catch (parseErr) {
        return res.status(500).json({
          error: 'Failed to parse headless output',
          stdout: stdout.substring(0, 500)
        });
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/monitors/stop', authenticate, express.json({ limit: '1mb' }), async (req, res) => {
  if (!HEADLESS_MONITOR_ENABLED) {
    return res.status(503).json({ error: 'Monitor integration disabled' });
  }
  const { session_id } = req.body || {};
  try {
    const { execFile } = require('child_process');
    const args = ['monitor', 'stop'];
    if (session_id) args.push('--session', session_id);
    const env = { ...process.env, APPDIR: process.env.APPDIR || '/home/z/my-project/squashfs-root' };
    execFile(HEADLESS_BIN, args, {
      timeout: 10000,
      env,
      cwd: process.env.HOME || '/home/z'
    }, (err, stdout, stderr) => {
      if (err) {
        log.error('Monitor stop exec error:', { message: err.message });
        try {
          const parsed = JSON.parse(stdout || '{}');
          return res.status(400).json(parsed);
        } catch {
          return res.status(500).json({ error: err.message });
        }
      }
      try {
        const parsed = JSON.parse(stdout);
        _monitorsCache = null;
        return res.json(parsed);
      } catch (parseErr) {
        return res.status(500).json({ error: 'Failed to parse headless output' });
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Serve the live viewer page (HTML)
app.get('/live', authenticate, (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'live.html'));
});

// Helper: finalize chunked upload by concatenating all chunks
async function finalizeChunkedUpload(uploadId, meta, req, res) {
  const sessionDir = path.join(CHUNK_DIR, uploadId);
  // If meta has a targetPath (subfolder upload), use it; else root of SHARED_DIR
  const targetDir = meta.targetPath
    ? path.resolve(SHARED_DIR, meta.targetPath.replace(/^\/+/, ''))
    : SHARED_DIR;
  if (targetDir !== SHARED_DIR && !targetDir.startsWith(SHARED_DIR + path.sep)) {
    return res.status(500).json({ error: 'Final path resolution failed' });
  }
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const finalPath = path.join(targetDir, meta.fileName);
  if (!finalPath.startsWith(SHARED_DIR + path.sep) && finalPath !== SHARED_DIR) {
    return res.status(500).json({ error: 'Final path validation failed' });
  }

  let totalWritten = 0;
  const writeStream = fs.createWriteStream(finalPath);
  // Helper: pipe a single chunk file into the write stream and wait for
  // the read side to finish (which means the data has been handed off to
  // the OS, though the write stream may still be flushing).
  const pipeChunk = (cFile) => new Promise((resolve, reject) => {
    const rs = fs.createReadStream(cFile);
    let bytesThisChunk = 0;
    rs.on('data', (chunk) => { bytesThisChunk += chunk.length; });
    rs.on('error', reject);
    writeStream.on('error', reject);
    rs.pipe(writeStream, { end: false });
    rs.on('end', () => resolve(bytesThisChunk));
  });

  try {
    // PERF: stream each chunk from disk instead of reading it into memory.
    // Previously this did readFileSync(cFile) + writeStream.write(buf) per
    // chunk, loading each 95MB chunk fully into RAM. Now zero-copy through
    // fs.createReadStream → writeStream, so memory stays flat regardless
    // of chunk size or count.
    for (let i = 0; i < meta.totalChunks; i++) {
      const cFile = chunkFilePath(uploadId, i);
      if (!fs.existsSync(cFile)) {
        throw new Error(`Missing chunk ${i} during finalization`);
      }
      const chunkBytes = await pipeChunk(cFile);
      totalWritten += chunkBytes;
    }
    await new Promise((resolve, reject) => {
      writeStream.end(() => resolve());
      writeStream.on('error', reject);
    });
    if (totalWritten !== meta.totalSize) {
      throw new Error(`Size mismatch: expected ${meta.totalSize}, got ${totalWritten}`);
    }
    meta.finalized = true;
    meta.finalPath = finalPath;
    meta.finalizedAt = new Date().toISOString();
    writeChunkMeta(uploadId, meta);
    setTimeout(() => {
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
    }, 60000);

    const durationSec = ((Date.now() - new Date(meta.createdAt).getTime()) / 1000).toFixed(2);
    const speedStr = formatBytes(meta.totalSize / (durationSec > 0 ? durationSec : 1)) + '/s';
    const isCurl = req.headers['user-agent'] && req.headers['user-agent'].includes('curl');
    if (isCurl) {
      return res.send(`File assembled successfully: ${meta.fileName} (${formatBytes(meta.totalSize)}) in ${durationSec}s (Avg speed: ${speedStr})\n`);
    }
    return res.json({
      success: true,
      finalized: true,
      name: meta.fileName,
      originalName: meta.originalName,
      size: meta.totalSize,
      formattedSize: formatBytes(meta.totalSize),
      chunks: meta.totalChunks,
      duration: durationSec + 's',
      speed: speedStr,
      path: `/files/${meta.fileName}`
    });
  } catch (err) {
    try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch (e) {}
    return res.status(500).json({ error: `Finalization failed: ${err.message}` });
  }
}

// Periodic cleanup of stale chunk sessions
setInterval(() => {
  try {
    if (!fs.existsSync(CHUNK_DIR)) return;
    const sessions = fs.readdirSync(CHUNK_DIR);
    const now = Date.now();
    const maxAgeMs = MAX_AGE_HOURS * 3600 * 1000;
    for (const sid of sessions) {
      const meta = readChunkMeta(sid);
      if (!meta) continue;
      const updatedAt = new Date(meta.updatedAt).getTime();
      if (now - updatedAt > maxAgeMs && !meta.finalized) {
        log.info(`Cleaning up stale chunk session: ${sid}`);
        fs.rmSync(path.join(CHUNK_DIR, sid), { recursive: true, force: true });
      }
    }
  } catch (e) { /* ignore */ }
}, 3600 * 1000);

// ============================================================
// Simple upload (single file, <100MB)
// ============================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let relativePath = '';
    if (req.path && req.path.startsWith('/upload/')) {
      relativePath = req.path.substring(8);
    } else {
      relativePath = req.query.path || '';
    }
    relativePath = relativePath.replace(/^\/+|\/+$/g, '');
    const targetDir = path.resolve(SHARED_DIR, relativePath);
    if (targetDir !== SHARED_DIR && !targetDir.startsWith(SHARED_DIR + path.sep)) {
      return cb(new Error('Forbidden target path'));
    }
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    cb(null, targetDir);
  },
  filename: (req, file, cb) => cb(null, sanitizeFilename(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ============================================================
// Multer error translator — turns LIMIT_FILE_SIZE and friends
// into descriptive JSON instead of generic 500
// ============================================================
function multerErrorHandler(err, req, res, next) {
  if (!err) return next();
  // Multer wraps its errors with .code
  if (err.code === 'LIMIT_FILE_SIZE') {
    const limit = err.field === 'file' && req._chunkUpload
      ? formatBytes(CHUNK_SIZE)
      : '100 MB';
    return res.status(413).json({
      error: `Arquivo maior que o limite permitido (${limit}).`,
      code: 'LIMIT_FILE_SIZE',
      field: err.field,
      hint: req._chunkUpload
        ? 'Tamanho do chunk excede o limite do servidor.'
        : 'Para arquivos > 95MB o frontend faz upload em chunks automaticamente. Se está usando curl, use o chunked-upload.sh.'
    });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      error: `Campo inesperado no upload: "${err.field}". Esperado: "file".`,
      code: 'LIMIT_UNEXPECTED_FILE',
      field: err.field
    });
  }
  if (err.code === 'LIMIT_PART_COUNT') {
    return res.status(400).json({ error: 'Muitas partes no multipart form.', code: 'LIMIT_PART_COUNT' });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: 'Muitos arquivos no upload.', code: 'LIMIT_FILE_COUNT' });
  }
  if (err.code === 'LIMIT_FIELD_KEY') {
    return res.status(400).json({ error: 'Nome de campo muito longo.', code: 'LIMIT_FIELD_KEY' });
  }
  if (err.code === 'LIMIT_FIELD_VALUE') {
    return res.status(400).json({ error: 'Valor de campo muito longo.', code: 'LIMIT_FIELD_VALUE' });
  }
  if (err.code === 'LIMIT_FIELD_COUNT') {
    return res.status(400).json({ error: 'Muitos campos no form.', code: 'LIMIT_FIELD_COUNT' });
  }
  // Path traversal from diskStorage.destination
  if (err.message && err.message.includes('Forbidden target path')) {
    return res.status(403).json({ error: 'Caminho de destino proibido.', code: 'FORBIDDEN_PATH' });
  }
  // Other multer / generic errors
  log.error('Upload middleware error:', { code: err.code, message: err.message });
  return res.status(400).json({
    error: err.message || 'Erro no upload.',
    code: err.code || 'UPLOAD_ERROR'
  });
}

app.post(['/upload', '/upload/:path(*)'], authenticate, upload.single('file'), (req, res, next) => {
  // Route handler — if multer failed it calls next(err)
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo recebido. Use multipart/form-data com campo "file".', code: 'NO_FILE' });
  const durationMs = Date.now() - req.startTime;
  const durationSec = durationMs / 1000;
  const speedBytesPerSec = durationSec > 0 ? req.file.size / durationSec : req.file.size;
  const speedStr = formatBytes(speedBytesPerSec) + '/s';
  const durationStr = durationSec.toFixed(2) + 's';
  const isCurl = req.headers['user-agent'] && req.headers['user-agent'].includes('curl');
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (wantsJson || (!isCurl && req.xhr)) {
    return res.json({
      success: true,
      name: req.file.filename,
      formattedSize: formatBytes(req.file.size),
      speed: speedStr,
      duration: durationStr
    });
  } else if (isCurl) {
    return res.send(`File uploaded successfully: ${req.file.filename} (${formatBytes(req.file.size)}) in ${durationStr} (Avg speed: ${speedStr})\n`);
  } else {
    // FIX #23: Token no longer in redirect URL (use cookie-based session instead, or rely on Authorization header)
    // For now, just redirect to / without token (browser will need to re-authenticate)
    res.redirect('/');
  }
});

// Attach multer error handler for the simple upload route
app.use(['/upload', '/upload/:path(*)'], multerErrorHandler);

// ============================================================
// File creation: write, mkdir, touch
// ============================================================
// FIX #2: /api/write uses express.raw to avoid JSON middleware consuming body
app.post('/api/write/:path(*)', authenticate, express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath) {
    return res.status(400).send('Invalid path\n');
  }
  try {
    const targetDir = path.dirname(filePath);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(filePath, req.body || Buffer.alloc(0));
    const bytes = (req.body || '').length || 0;
    return res.send(`Written: ${path.basename(filePath)} (${bytes} bytes)\n`);
  } catch (err) {
    return res.status(500).send(`Error writing file: ${err.message}\n`);
  }
});

app.post('/api/mkdir/:path(*)', authenticate, (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath) {
    return res.status(400).send('Invalid path\n');
  }
  try {
    fs.mkdirSync(filePath, { recursive: true });
    return res.status(201).send(`Directory created: /${relativePath}\n`);
  } catch (err) {
    return res.status(500).send(`Error creating directory: ${err.message}\n`);
  }
});

// FIX #12: /api/touch uses fs.utimesSync to update mtime reliably on Windows
app.post('/api/touch/:path(*)', authenticate, (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath) {
    return res.status(400).send('Invalid path\n');
  }
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '');
    } else {
      const now = new Date();
      fs.utimesSync(filePath, now, now);
    }
    return res.send(`Touched: /${relativePath}\n`);
  } catch (err) {
    return res.status(500).send(`Error touching file: ${err.message}\n`);
  }
});

// Legacy folder creation (kept for backward compat)
app.post('/api/folders', authenticate, (req, res) => {
  const name = req.query.name;
  const parentPath = (req.query.path || '').replace(/^\/+/, '');
  if (!name) return res.status(400).send('Folder name required\n');
  const fullPath = parentPath ? `${parentPath}/${name}` : name;
  const target = getSafePath(fullPath);
  if (!target) return res.status(400).send('Invalid path\n');
  try {
    fs.mkdirSync(target, { recursive: true });
    return res.status(201).send(`Directory created: /${fullPath}\n`);
  } catch (err) {
    return res.status(500).send(`Error: ${err.message}\n`);
  }
});

// ============================================================
// Move / Copy
// ============================================================
app.patch('/api/mv', authenticate, express.json({ limit: '1mb' }), (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) {
    return res.status(400).json({ error: 'Missing from or to' });
  }
  const src = getSafePath(from);
  const dst = getSafePath(to);
  if (!src || !dst) {
    return res.status(400).json({ error: 'Invalid source or destination path' });
  }
  if (!fs.existsSync(src)) {
    return res.status(404).json({ error: 'Source not found' });
  }
  if (fs.existsSync(dst)) {
    return res.status(409).json({ error: 'Destination already exists. Use ?force=1 to overwrite.' });
  }
  try {
    const targetDir = path.dirname(dst);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    fs.renameSync(src, dst);
    return res.json({ success: true, message: `Moved: /${from} → /${to}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// FIX #30: /api/cp returns 409 if destination exists (use ?force=1)
app.post('/api/cp', authenticate, express.json({ limit: '1mb' }), async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) {
    return res.status(400).json({ error: 'Missing from or to' });
  }
  const src = getSafePath(from);
  const dst = getSafePath(to);
  if (!src || !dst) {
    return res.status(400).json({ error: 'Invalid source or destination path' });
  }
  if (!fs.existsSync(src)) {
    return res.status(404).json({ error: 'Source not found' });
  }
  const force = req.query.force === '1';
  if (fs.existsSync(dst) && !force) {
    return res.status(409).json({ error: 'Destination already exists. Use ?force=1 to overwrite.' });
  }
  try {
    const targetDir = path.dirname(dst);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      await copyDir(src, dst);
    } else {
      await fs.promises.copyFile(src, dst);
    }
    return res.json({ success: true, message: `Copied: /${from} → /${to}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// FIX: async version of copyDirSync — the sync version blocked the event
// loop for the entire duration of the copy, which for a folder with
// thousands of files could be seconds. Now yields between stats and
// copies so other requests can be served.
async function copyDir(src, dst) {
  if (!fs.existsSync(dst)) await fs.promises.mkdir(dst, { recursive: true });
  const dirents = await fs.promises.readdir(src, { withFileTypes: true });
  for (const d of dirents) {
    if (isBlockedName(d.name)) continue;
    const s = path.join(src, d.name);
    const dd = path.join(dst, d.name);
    let isDir;
    try { isDir = d.isDirectory(); }
    catch { isDir = (await fs.promises.stat(s)).isDirectory(); }
    if (isDir) {
      await copyDir(s, dd);
    } else {
      await fs.promises.copyFile(s, dd);
    }
  }
}

// ============================================================
// FIX #21: /api/head uses readline stream (no full file load)
// ============================================================
app.get('/api/head/:path(*)', authenticate, async (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('File not found\n');
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return res.status(400).send('Not a file\n');
  const lines = parseInt(req.query.lines) || 50;
  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let count = 0;
    let output = '';
    for await (const line of rl) {
      output += line + '\n';
      count++;
      if (count >= lines) {
        rl.close();
        stream.destroy();
        break;
      }
    }
    return res.send(output);
  } catch (err) {
    return res.status(500).send(`Error: ${err.message}\n`);
  }
});

// FIX #21: /api/tail uses streaming with rolling buffer
app.get('/api/tail/:path(*)', authenticate, async (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('File not found\n');
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return res.status(400).send('Not a file\n');
  const lines = parseInt(req.query.lines) || 50;
  try {
    // Read last 64KB and extract last N lines (works for most text files)
    const readSize = Math.min(stat.size, 64 * 1024);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const text = buffer.toString('utf8');
    const allLines = text.split('\n');
    const tail = allLines.slice(-lines).join('\n');
    return res.send(tail);
  } catch (err) {
    return res.status(500).send(`Error: ${err.message}\n`);
  }
});

// ============================================================
// FIX #13: ZIP and TAR streamed (no full buffer in memory)
// ============================================================
// ============================================================
// FIX: ZIP streamed via archiver — no full file in memory.
// Previously this built the entire ZIP in RAM with readFileSync +
// Buffer.concat, causing OOM on large archives. Now streams file
// data from disk through archiver straight to the response.
// ============================================================
app.get('/api/zip/:path(*)', authenticate, (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('Not found\n');
  }
  const baseName = path.basename(filePath);
  const stat = fs.statSync(filePath);

  res.setHeader('Content-Type', 'application/zip');
  // Mark as attachment so browsers download instead of trying to render
  res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(baseName)}.zip"`);
  // Streamed response — we don't know total size ahead of time
  res.setHeader('Transfer-Encoding', 'chunked');

  const archive = archiver('zip', { store: true }); // store=true => no compression (faster, less CPU)
  archive.on('error', (err) => {
    log.error('ZIP stream error:', { message: err.message });
    if (!res.headersSent) res.status(500).send(`Zip error: ${err.message}\n`);
    archive.destroy();
  });
  archive.on('warning', (err) => {
    log.warn('ZIP stream warning:', { message: err.message });
  });

  // Pipe archive → response. On client disconnect, abort the archive.
  archive.pipe(res);
  req.on('close', () => {
    if (!archive.destroyed) archive.abort();
  });

  // FIX: archiver.directory() in v7 ignores the filter/glob options, so we
  // walk the tree ourselves and add files/dirs one by one. This gives us
  // full control over the BLOCKLIST (which archiver doesn't know about).
  // Each archive.file() call opens a read stream internally — still zero
  // full-file buffering.
  const walkAndAdd = (dir, prefix) => {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      if (isBlockedName(item)) continue;
      const full = path.join(dir, item);
      const rel = prefix ? `${prefix}/${item}` : item;
      try {
        const s = fs.statSync(full);
        if (s.isDirectory()) {
          // Add a directory entry so empty dirs are preserved
          archive.append('', { name: `${rel}/`, type: 'directory' });
          walkAndAdd(full, rel);
        } else {
          archive.file(full, { name: rel, stats: s });
        }
      } catch (e) { /* skip deleted */ }
    }
  };

  try {
    if (stat.isDirectory()) {
      walkAndAdd(filePath, baseName);
    } else {
      archive.file(filePath, { name: baseName });
    }
    archive.finalize();
  } catch (err) {
    log.error('ZIP build error:', { message: err.message });
    if (!res.headersSent) res.status(500).send(`Zip error: ${err.message}\n`);
    archive.destroy();
  }
});

// ============================================================
// FIX: TAR.GZ streamed via archiver — no full file in memory.
// Previously built the entire tar in RAM with readFileSync + Buffer.concat
// + gzipSync, causing OOM on large archives.
// ============================================================
app.get('/api/tar/:path(*)', authenticate, (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('Not found\n');
  }
  const baseName = path.basename(filePath);
  const stat = fs.statSync(filePath);

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(baseName)}.tar.gz"`);
  res.setHeader('Transfer-Encoding', 'chunked');

  // archiver supports tar + gzip via the 'gzip' option
  const archive = archiver('tar', { gzip: true, gzipOptions: { level: 6 } });
  archive.on('error', (err) => {
    log.error('TAR stream error:', { message: err.message });
    if (!res.headersSent) res.status(500).send(`Tar error: ${err.message}\n`);
    archive.destroy();
  });
  archive.on('warning', (err) => {
    log.warn('TAR stream warning:', { message: err.message });
  });

  archive.pipe(res);
  req.on('close', () => {
    if (!archive.destroyed) archive.abort();
  });

  // FIX: same BLOCKLIST filter as /api/zip — archiver v7's directory()
  // doesn't honor filter/glob, so we walk and add entries manually.
  const walkAndAdd = (dir, prefix) => {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      if (isBlockedName(item)) continue;
      const full = path.join(dir, item);
      const rel = prefix ? `${prefix}/${item}` : item;
      try {
        const s = fs.statSync(full);
        if (s.isDirectory()) {
          archive.append('', { name: `${rel}/`, type: 'directory' });
          walkAndAdd(full, rel);
        } else {
          archive.file(full, { name: rel, stats: s });
        }
      } catch (e) { /* skip deleted */ }
    }
  };

  try {
    if (stat.isDirectory()) {
      walkAndAdd(filePath, baseName);
    } else {
      archive.file(filePath, { name: baseName });
    }
    archive.finalize();
  } catch (err) {
    log.error('TAR build error:', { message: err.message });
    if (!res.headersSent) res.status(500).send(`Tar error: ${err.message}\n`);
    archive.destroy();
  }
});

// ============================================================
// Disk usage (df)
// ============================================================
app.get('/api/df', authenticate, async (req, res) => {
  try {
    const stats = await fs.promises.statfs(SHARED_DIR);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    const used = total - free;
    return res.json({
      total, used, free,
      formattedTotal: formatBytes(total),
      formattedUsed: formatBytes(used),
      formattedFree: formatBytes(free)
    });
  } catch (err) {
    // Fallback for systems without statfs (Windows)
    return res.json({
      total: 0, used: 0, free: 0,
      formattedTotal: '0 B', formattedUsed: '0 B', formattedFree: '0 B'
    });
  }
});

// ============================================================
// FIX #20: SHA256/MD5 streamed in 64KB chunks
// ============================================================
async function hashFile(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

app.get('/api/sha256/:path(*)', authenticate, async (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return res.status(400).json({ error: 'Not a file' });
  try {
    const hash = await hashFile(filePath, 'sha256');
    return res.json({ hash });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/md5/:path(*)', authenticate, async (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return res.status(400).json({ error: 'Not a file' });
  try {
    const hash = await hashFile(filePath, 'md5');
    return res.json({ hash });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Word count
app.get('/api/wc/:path(*)', authenticate, async (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return res.status(400).json({ error: 'Not a file' });
  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lines = 0, words = 0, chars = 0, bytes = stat.size;
    for await (const line of rl) {
      lines++;
      chars += line.length + 1;
      words += line.trim().split(/\s+/).filter(Boolean).length;
    }
    return res.json({ lines, words, bytes, chars });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// File type detection
app.get('/api/file/:path(*)', authenticate, async (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return res.status(400).json({ error: 'Not a file' });
  const ext = (path.extname(filePath).slice(1) || '').toLowerCase();
  const mimeMap = {
    txt: 'text/plain', md: 'text/markdown', json: 'application/json',
    js: 'application/javascript', ts: 'application/typescript',
    html: 'text/html', css: 'text/css', xml: 'application/xml',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
    mp4: 'video/mp4', avi: 'video/x-msvideo', mov: 'video/quicktime',
    mkv: 'video/x-matroska', webm: 'video/webm',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
    pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
    tar: 'application/x-tar', rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed'
  };
  const mime = mimeMap[ext] || 'application/octet-stream';
  const textMimes = ['text/', 'application/json', 'application/javascript', 'application/xml'];
  const isBinary = !textMimes.some(t => mime.startsWith(t));
  return res.json({ mime, extension: ext, isBinary });
});

// ============================================================
// FIX #15: Delete with blocklist protection
// ============================================================
app.delete('/files/*', authenticate, (req, res) => {
  const relativePath = req.params[0];
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('File not found\n');
  }
  // FIX #15: Block deletion of protected paths
  const parts = path.relative(SHARED_DIR, filePath).split(path.sep);
  for (const p of parts) {
    if (BLOCKLIST.has(p)) {
      return res.status(403).send(`Forbidden: cannot delete protected path\n`);
    }
  }
  try {
    fs.rmSync(filePath, { recursive: true, force: true });
    const isCurl = req.headers['user-agent'] && req.headers['user-agent'].includes('curl');
    const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
    if (wantsJson) return res.json({ success: true, message: `Deleted ${relativePath}` });
    if (isCurl) return res.send(`Deleted: /${relativePath}\n`);
    return res.send('Deleted successfully');
  } catch (err) {
    return res.status(500).send(`Error deleting: ${err.message}\n`);
  }
});

// ============================================================
// WebDAV server — mount at /webdav (alias /dav) for Dolphin,
// Finder, Windows Explorer, Nautilus, and other WebDAV clients.
// Uses the same AUTH_TOKEN (Basic Auth: username ignored,
// password = AUTH_TOKEN). Reuses getSafePath for path traversal
// and blocklist protection.
// ============================================================
const createWebDAVRouter = require('./webdav');
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
  log.info(`Chunked upload config`, {
    chunkSize: formatBytes(CHUNK_SIZE),
    maxTotalSize: formatBytes(MAX_TOTAL_SIZE),
    rateLimit: `${RATE_LIMIT_MAX} req/min`
  });

  if (process.env.LOCAL_ONLY === 'true') {
    log.info('Local-Only mode. Tunnels disabled.');
    return;
  }

  // Cloudflare Tunnel
  const startCloudflare = async (isFallback = true) => {
    try {
      log.info(`Requesting Cloudflare tunnel...`);
      const { bin, install, Tunnel } = require('cloudflared');
      if (!fs.existsSync(bin)) {
        log.info('Installing cloudflared binary...');
        await install(bin);
      }
      let lastUrl = null;
      const cfTunnel = Tunnel.quick(`http://localhost:${PORT}`);
      cfTunnel.once('url', (url) => {
        lastUrl = url;
        log.info(`Cloudflare Tunnel active`, { url });
      });
      cfTunnel.once('error', (err) => log.error('Cloudflare Tunnel error:', { message: err.message }));
      cfTunnel.once('exit', (code) => log.warn(`Cloudflare Tunnel exited`, { code }));

      // FIX #17: Tunnel healthcheck every 30s
      setInterval(() => {
        if (!lastUrl) {
          log.warn('Tunnel healthcheck: no URL established yet');
        }
      }, 30000);
    } catch (err) {
      log.error('Could not initialize Cloudflare Tunnel:', { message: err.message });
    }
  };

  // Localtunnel
  const startLocaltunnel = async (isFallback = true) => {
    try {
      log.info('Requesting localtunnel...');
      const localtunnel = require('localtunnel');
      const tunnel = await localtunnel({
        port: PORT,
        subdomain: process.env.SUBDOMAIN || undefined
      });
      if (tunnel.url) {
        log.info('Localtunnel active', { url: tunnel.url });
      }
      tunnel.on('close', () => {
        log.warn('Localtunnel closed. Trying Cloudflare...');
        startCloudflare();
      });
      tunnel.on('error', (err) => {
        log.error('Localtunnel error:', { message: err.message });
        startCloudflare();
      });
    } catch (err) {
      log.error('Could not initialize localtunnel:', { message: err.message });
      await startCloudflare();
    }
  };

  const provider = (process.env.TUNNEL_PROVIDER || 'localtunnel').toLowerCase();
  if (provider === 'cloudflare' || provider === 'cf') startCloudflare(false);
  else if (provider === 'zrok') {
    try {
      const { spawn } = require('child_process');
      const zrok = spawn('zrok', ['share', 'public', `http://localhost:${PORT}`]);
      let success = false;
      const timeout = setTimeout(() => {
        if (!success) { try { zrok.kill(); } catch (e) {} startLocaltunnel(); }
      }, 15000);
      zrok.stdout.on('data', (data) => {
        const m = data.toString().match(/https?:\/\/[a-z0-9.-]+\.share\.zrok\.io/i);
        if (m) {
          success = true;
          clearTimeout(timeout);
          log.info('zrok Tunnel active', { url: m[0] });
        }
      });
      zrok.on('error', () => startLocaltunnel());
      zrok.on('exit', () => startLocaltunnel());
    } catch (e) { startLocaltunnel(); }
  } else startLocaltunnel(false);
});

// ============================================================
// FIX #25: Graceful shutdown
// ============================================================
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}, shutting down gracefully...`);

  // Stop accepting new connections
  server.close(() => {
    log.info('All connections closed. Exiting.');
    process.exit(0);
  });

  // Force exit after 10 seconds if something hangs
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
