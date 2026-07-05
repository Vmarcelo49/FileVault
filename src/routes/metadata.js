// ============================================================
// routes/metadata.js — File metadata + content inspection.
// Endpoints: /api/stat, /api/du, /api/df, /api/file (type detection),
//            /api/head, /api/tail (streaming line readers)
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { SHARED_DIR } = require('../config');
const { getSafePath, isBlockedName } = require('../lib/paths');
const { formatBytes } = require('../lib/files');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.get('/api/stat/:path(*)', authenticate, async (req, res) => {
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
      isDir: stat.isDirectory(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/api/du/:path(*)', authenticate, async (req, res) => {
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
      fileCount,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/api/df', authenticate, async (req, res) => {
  try {
    const stats = await fs.promises.statfs(SHARED_DIR);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    const used = total - free;
    return res.json({
      total, used, free,
      formattedTotal: formatBytes(total),
      formattedUsed: formatBytes(used),
      formattedFree: formatBytes(free),
    });
  } catch (err) {
    return res.json({
      total: 0, used: 0, free: 0,
      formattedTotal: '0 B', formattedUsed: '0 B', formattedFree: '0 B',
    });
  }
});

router.get('/api/file/:path(*)', authenticate, async (req, res) => {
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
    tar: 'application/x-tar', rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';
  const textMimes = ['text/', 'application/json', 'application/javascript', 'application/xml'];
  const isBinary = !textMimes.some(t => mime.startsWith(t));
  return res.json({ mime, extension: ext, isBinary });
});

router.get('/api/head/:path(*)', authenticate, async (req, res) => {
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

router.get('/api/tail/:path(*)', authenticate, async (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('File not found\n');
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return res.status(400).send('Not a file\n');
  const lines = parseInt(req.query.lines) || 50;
  try {
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

module.exports = router;
