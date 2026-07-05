// ============================================================
// lib/chunks.js — Chunked upload storage helpers + finalization.
// All filesystem operations for chunk sessions live here.
// ============================================================
const fs = require('fs');
const path = require('path');
const { CHUNK_DIR, CHUNK_SIZE, MAX_TOTAL_SIZE } = require('../config');
const { sanitizeFilename } = require('./paths');
const { formatBytes } = require('./files');
const log = require('../log');

const UPLOAD_ID_REGEX = /^[a-zA-Z0-9_-]{4,128}$/;

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
// Per-uploadId mutex — prevents race conditions when two chunks
// arrive concurrently. Without this, both see existsSync=false,
// both write the chunk file, and the second writeChunkMeta call
// overwrites the first — meta.receivedChunks ends up out of sync
// with disk reality.
// ============================================================
const _uploadLocks = new Map();
function withUploadLock(uploadId, fn) {
  const prev = _uploadLocks.get(uploadId) || Promise.resolve();
  const next = prev.then(() => fn());
  const stored = next.catch(() => {});
  _uploadLocks.set(uploadId, stored);
  stored.then(() => {
    if (_uploadLocks.get(uploadId) === stored) {
      _uploadLocks.delete(uploadId);
    }
  });
  return next;
}

/**
 * Finalize a chunked upload by streaming all chunks into the final
 * file. Uses fs.createReadStream → writeStream pipe per chunk so
 * memory stays flat regardless of chunk size or count.
 *
 * @param {string} uploadId
 * @param {object} meta   The meta.json contents (mutated: finalized, finalPath, finalizedAt)
 * @param {object} req    Express request (for user-agent detection)
 * @param {object} res    Express response
 */
async function finalizeChunkedUpload(uploadId, meta, req, res) {
  const { SHARED_DIR } = require('../config');
  const sessionDir = path.join(CHUNK_DIR, uploadId);
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
      path: `/files/${meta.fileName}`,
    });
  } catch (err) {
    try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch (e) {}
    return res.status(500).json({ error: `Finalization failed: ${err.message}` });
  }
}

/**
 * Periodic cleanup of stale chunk sessions. Call once at startup.
 */
function startChunkCleanup(maxAgeHours) {
  setInterval(() => {
    try {
      if (!fs.existsSync(CHUNK_DIR)) return;
      const sessions = fs.readdirSync(CHUNK_DIR);
      const now = Date.now();
      const maxAgeMs = maxAgeHours * 3600 * 1000;
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
}

module.exports = {
  UPLOAD_ID_REGEX,
  chunkMetaPath, chunkFilePath,
  readChunkMeta, writeChunkMeta, listReceivedChunks,
  withUploadLock, finalizeChunkedUpload,
  startChunkCleanup,
};
