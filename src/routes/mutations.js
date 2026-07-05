// ============================================================
// routes/mutations.js — File creation, move, copy.
// Endpoints: /api/write, /api/mkdir, /api/touch, /api/folders (legacy),
//            /api/mv, /api/cp
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const { SHARED_DIR } = require('../config');
const { getSafePath, isBlockedName, sanitizeFilename } = require('../lib/paths');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.post('/api/write/:path(*)', authenticate, express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath) return res.status(400).send('Invalid path\n');
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

router.post('/api/mkdir/:path(*)', authenticate, (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath) return res.status(400).send('Invalid path\n');
  try {
    fs.mkdirSync(filePath, { recursive: true });
    return res.status(201).send(`Directory created: /${relativePath}\n`);
  } catch (err) {
    return res.status(500).send(`Error creating directory: ${err.message}\n`);
  }
});

router.post('/api/touch/:path(*)', authenticate, (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath) return res.status(400).send('Invalid path\n');
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

router.post('/api/folders', authenticate, (req, res) => {
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

router.patch('/api/mv', authenticate, express.json({ limit: '1mb' }), (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'Missing from or to' });
  const src = getSafePath(from);
  const dst = getSafePath(to);
  if (!src || !dst) return res.status(400).json({ error: 'Invalid source or destination path' });
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'Source not found' });
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

router.post('/api/cp', authenticate, express.json({ limit: '1mb' }), async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'Missing from or to' });
  const src = getSafePath(from);
  const dst = getSafePath(to);
  if (!src || !dst) return res.status(400).json({ error: 'Invalid source or destination path' });
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'Source not found' });
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

/**
 * Async recursive copy. Yields between iterations so the event loop
 * can serve other requests during a large copy.
 */
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

module.exports = router;
