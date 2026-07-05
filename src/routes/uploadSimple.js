// ============================================================
// routes/uploadSimple.js — Single-file upload via multipart/form-data.
// Capped at 100MB. For larger files, use the chunked upload endpoints.
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { SHARED_DIR } = require('../config');
const { sanitizeFilename, getSafePath } = require('../lib/paths');
const { formatBytes } = require('../lib/files');
const { authenticate } = require('../middleware/auth');
const log = require('../log');

const router = express.Router();

// Multer disk storage — writes directly to the target dir (no memory buffering)
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
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    cb(null, targetDir);
  },
  filename: (req, file, cb) => cb(null, sanitizeFilename(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ============================================================
// Multer error translator — translates LIMIT_FILE_SIZE and friends
// into descriptive JSON: { error, code, hint }
// ============================================================
function multerErrorHandler(err, req, res, next) {
  if (!err) return next();
  const CHUNK_SIZE = require('../config').CHUNK_SIZE;
  if (err.code === 'LIMIT_FILE_SIZE') {
    const limit = err.field === 'file' && req._chunkUpload ? formatBytes(CHUNK_SIZE) : '100 MB';
    return res.status(413).json({
      error: `Arquivo maior que o limite permitido (${limit}).`,
      code: 'LIMIT_FILE_SIZE',
      field: err.field,
      hint: req._chunkUpload
        ? 'Tamanho do chunk excede o limite do servidor.'
        : 'Para arquivos > 95MB o frontend faz upload em chunks automaticamente. Se está usando curl, use o chunked-upload.sh.',
    });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      error: `Campo inesperado no upload: "${err.field}". Esperado: "file".`,
      code: 'LIMIT_UNEXPECTED_FILE',
      field: err.field,
    });
  }
  if (err.code === 'LIMIT_PART_COUNT') return res.status(400).json({ error: 'Muitas partes no multipart form.', code: 'LIMIT_PART_COUNT' });
  if (err.code === 'LIMIT_FILE_COUNT')  return res.status(400).json({ error: 'Muitos arquivos no upload.', code: 'LIMIT_FILE_COUNT' });
  if (err.code === 'LIMIT_FIELD_KEY')   return res.status(400).json({ error: 'Nome de campo muito longo.', code: 'LIMIT_FIELD_KEY' });
  if (err.code === 'LIMIT_FIELD_VALUE') return res.status(400).json({ error: 'Valor de campo muito longo.', code: 'LIMIT_FIELD_VALUE' });
  if (err.code === 'LIMIT_FIELD_COUNT') return res.status(400).json({ error: 'Muitos campos no form.', code: 'LIMIT_FIELD_COUNT' });
  if (err.message && err.message.includes('Forbidden target path')) {
    return res.status(403).json({ error: 'Caminho de destino proibido.', code: 'FORBIDDEN_PATH' });
  }
  log.error('Upload middleware error:', { code: err.code, message: err.message });
  return res.status(400).json({ error: err.message || 'Erro no upload.', code: err.code || 'UPLOAD_ERROR' });
}

router.post(['/upload', '/upload/:path(*)'], authenticate, upload.single('file'), (req, res, next) => {
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
      duration: durationStr,
    });
  }
  if (isCurl) {
    return res.send(`File uploaded successfully: ${req.file.filename} (${formatBytes(req.file.size)}) in ${durationStr} (Avg speed: ${speedStr})\n`);
  }
  res.redirect('/');
});

// Attach multer error handler at the same mount path
router.use(['/upload', '/upload/:path(*)'], multerErrorHandler);

module.exports = router;
module.exports.multerErrorHandler = multerErrorHandler;
