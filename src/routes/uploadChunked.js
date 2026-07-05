// ============================================================
// routes/uploadChunked.js — Chunked upload endpoints for large files.
// Endpoints: POST /upload/chunk/init, POST /upload/chunk,
//            GET  /upload/chunk/status, DELETE /upload/chunk,
//            GET  /api/uploads
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { SHARED_DIR, CHUNK_DIR, CHUNK_SIZE, MAX_TOTAL_SIZE } = require('../config');
const { sanitizeFilename } = require('../lib/paths');
const { formatBytes } = require('../lib/files');
const {
  UPLOAD_ID_REGEX, readChunkMeta, writeChunkMeta, listReceivedChunks,
  withUploadLock, finalizeChunkedUpload,
} = require('../lib/chunks');
const { authenticate } = require('../middleware/auth');
const log = require('../log');

const router = express.Router();

// Multer config — chunks held in memory (chunk size capped at CHUNK_SIZE+1KB)
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHUNK_SIZE + 1024 },
});

// ============================================================
// POST /upload/chunk/init — initialize a session without sending data
// ============================================================
router.post('/upload/chunk/init', authenticate, express.json({ limit: '1mb' }), (req, res) => {
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
      return res.status(413).json({ error: 'Total size exceeds maximum allowed' });
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
      finalized: false,
    };
    writeChunkMeta(uploadId, meta);
    return res.json({
      success: true,
      uploadId,
      chunkSize: CHUNK_SIZE,
      expectedChunks: total,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /upload/chunk — upload a single chunk
// ============================================================
router.post('/upload/chunk', authenticate, (req, _res, next) => {
  req._chunkUpload = true;
  next();
}, chunkUpload.single('file'), async (req, res) => {
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
    const isLast = idx === total - 1;
    if (!isLast && req.file.size > CHUNK_SIZE) {
      return res.status(413).json({ error: `Chunk size ${req.file.size} exceeds limit ${CHUNK_SIZE}` });
    }

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
          finalized: false,
        };
        writeChunkMeta(uploadId, meta);
      } else if (!meta) {
        return res.status(409).json({
          error: 'Upload session not found. Send chunk 0 first or call POST /upload/chunk/init.',
        });
      }

      if (meta.finalized) {
        return res.status(409).json({ error: 'Upload already finalized', uploadId, fileName: meta.fileName });
      }
      if (meta.totalChunks !== total) {
        return res.status(409).json({ error: `totalChunks mismatch: expected ${meta.totalChunks}, got ${total}` });
      }

      const cFile = path.join(CHUNK_DIR, uploadId, `chunk_${String(idx).padStart(6, '0')}`);
      if (!fs.existsSync(cFile)) {
        fs.writeFileSync(cFile, req.file.buffer);
      }

      const onDisk = listReceivedChunks(uploadId);
      meta.receivedChunks = onDisk;
      meta.updatedAt = new Date().toISOString();
      writeChunkMeta(uploadId, meta);

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
        missing: Array.from({ length: total }, (_, i) => i).filter(i => !onDisk.includes(i)),
      });
    });
  } catch (err) {
    log.error('Chunk upload error:', { message: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /upload/chunk/status — progress for a specific session
// ============================================================
router.get('/upload/chunk/status', authenticate, (req, res) => {
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
    finalPath: meta.finalPath || null,
  });
});

// ============================================================
// DELETE /upload/chunk — cancel + cleanup
// ============================================================
router.delete('/upload/chunk', authenticate, (req, res) => {
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
// GET /api/uploads — list all chunked upload sessions
// ============================================================
router.get('/api/uploads', authenticate, (req, res) => {
  try {
    if (!fs.existsSync(CHUNK_DIR)) return res.json({ sessions: [], total: 0 });
    const includeFinalized = req.query.includeFinalized === '1';
    const sessions = [];
    const dirs = fs.readdirSync(CHUNK_DIR);
    for (const sid of dirs) {
      if (!UPLOAD_ID_REGEX.test(sid)) continue;
      const meta = readChunkMeta(sid);
      if (!meta) {
        sessions.push({
          uploadId: sid, orphan: true,
          createdAt: null, updatedAt: null, finalized: false,
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
        chunkSize: CHUNK_SIZE,
      });
    }
    sessions.sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    });
    return res.json({
      total: sessions.length,
      active: sessions.filter(s => !s.finalized).length,
      finalized: sessions.filter(s => s.finalized).length,
      sessions,
    });
  } catch (err) {
    log.error('List uploads error:', { message: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
