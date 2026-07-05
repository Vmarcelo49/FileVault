// ============================================================
// routes/files.js — File download (GET /files/*) and delete.
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const { SHARED_DIR, BLOCKLIST } = require('../config');
const { getSafePath, sanitizeFilename } = require('../lib/paths');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.get('/files/*', authenticate, (req, res) => {
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

  const disposition = req.query.download === '1' ? 'attachment' : 'inline';
  const safeName = sanitizeFilename(path.basename(filePath));
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.setHeader('Last-Modified', stat.mtime.toUTCString());

  res.sendFile(filePath);
});

router.delete('/files/*', authenticate, (req, res) => {
  const relativePath = req.params[0];
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('File not found\n');
  }
  const parts = path.relative(SHARED_DIR, filePath).split(path.sep);
  for (const p of parts) {
    if (BLOCKLIST.has(p)) {
      return res.status(403).send('Forbidden: cannot delete protected path\n');
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

module.exports = router;
