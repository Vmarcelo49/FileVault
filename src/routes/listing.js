// ============================================================
// routes/listing.js — Directory listing + tree + search.
// Endpoints: GET /, /ls/*, /api/files, /api/tree, /api/find, /api/health, /api/pwd
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const { SHARED_DIR, PKG_VERSION } = require('../config');
const { getSafePath, isBlockedName, isHiddenName } = require('../lib/paths');
const { formatBytes, getFilesRecursive, sortFiles } = require('../lib/files');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// /api/health — unauthenticated monitoring endpoint.
// Exposes only: status, uptime, version, authEnabled. No paths.
// ============================================================
router.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    version: PKG_VERSION,
    authEnabled: !!process.env.AUTH_TOKEN,
  });
});

router.get('/api/pwd', authenticate, (req, res) => {
  res.send(`${path.resolve(SHARED_DIR)}\n`);
});

// ============================================================
// Directory listing (plain-text for curl, JSON for Accept: json,
// HTML for browsers via sendFile in the parent app).
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
        if (isHiddenName(name, showChunks)) continue;
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
            path: relPath,
          });
        } catch (e) { /* skip deleted */ }
      }
    }

    files = sortFiles(files);

    if (wantsJson) return res.json(files);

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
    if (relativePath && !isRecursive) output += `Directory: ${relativePath}\n\n`;
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

// GET / — HTML for browsers, plain text for curl, JSON for Accept: json
router.get('/', authenticate, (req, res) => {
  const isCurl = req.headers['user-agent'] && req.headers['user-agent'].includes('curl');
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (!wantsJson && !isCurl) {
    return res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
  }
  const relativePath = (req.query.path || '').replace(/^\/+/, '');
  return handleDirectoryList(req, res, relativePath);
});

router.get(['/ls', '/ls/:path(*)'], authenticate, (req, res) => {
  const relativePath = (req.params.path || req.params[0] || '').replace(/^\/+/, '');
  return handleDirectoryList(req, res, relativePath);
});

router.get('/api/files', authenticate, async (req, res) => {
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
            path: relativePath ? `${relativePath}/${name}` : name,
          });
        } catch (e) { /* skip deleted */ }
      }
    }
    files = sortFiles(files);
    return res.json(files);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// /api/find — cached recursive search by glob pattern.
// Cache TTL: 30s OR until SHARED_DIR mtime changes.
// ============================================================
let _findCache = null;
let _findCacheAt = 0;
const FIND_CACHE_TTL_MS = 30 * 1000;

async function getFindIndex() {
  const now = Date.now();
  if (_findCache && (now - _findCacheAt) < FIND_CACHE_TTL_MS) {
    try {
      const dirStat = await fs.promises.stat(SHARED_DIR);
      if (dirStat.mtimeMs === _findCache.mtimeMs) return _findCache.files;
    } catch { /* fall through to refresh */ }
  }
  const dirStat = await fs.promises.stat(SHARED_DIR);
  const files = await getFilesRecursive(SHARED_DIR);
  _findCache = { mtimeMs: dirStat.mtimeMs, files };
  _findCacheAt = now;
  return files;
}

router.get('/api/find', authenticate, async (req, res) => {
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

router.get('/api/tree', authenticate, async (req, res) => {
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
        modified: stat.mtime.toISOString().replace('T', ' ').substring(0, 16),
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
              modified: s.mtime.toISOString().replace('T', ' ').substring(0, 16),
            });
          }
        }
        node.children = sortFiles(node.children);
      }
      return node;
    };
    const tree = await buildTree(targetDir, 0);
    return res.json(tree);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
