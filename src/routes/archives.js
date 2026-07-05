// ============================================================
// routes/archives.js — ZIP / TAR.GZ streaming endpoints.
// Wraps lib/archives.js with route handling + auth.
// ============================================================
const express = require('express');
const fs = require('fs');
const { getSafePath } = require('../lib/paths');
const { streamZip, streamTar } = require('../lib/archives');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.get('/api/zip/:path(*)', authenticate, (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('Not found\n');
  }
  streamZip(res, filePath, req);
});

router.get('/api/tar/:path(*)', authenticate, (req, res) => {
  const relativePath = req.params.path || req.params[0] || '';
  const filePath = getSafePath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('Not found\n');
  }
  streamTar(res, filePath, req);
});

module.exports = router;
