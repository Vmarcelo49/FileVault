// ============================================================
// routes/hashing.js — SHA-256, MD5, word count.
// All streamed — no full file in memory.
// ============================================================
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const { getSafePath } = require('../lib/paths');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

async function hashFile(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

router.get('/api/sha256/:path(*)', authenticate, async (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return res.status(400).json({ error: 'Not a file' });
  try {
    const hash = await hashFile(filePath, 'sha256');
    return res.json({ hash });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/api/md5/:path(*)', authenticate, async (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return res.status(400).json({ error: 'Not a file' });
  try {
    const hash = await hashFile(filePath, 'md5');
    return res.json({ hash });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/api/wc/:path(*)', authenticate, async (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
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

module.exports = router;
