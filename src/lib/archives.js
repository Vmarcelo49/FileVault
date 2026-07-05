// ============================================================
// lib/archives.js — Streamed ZIP / TAR.GZ builders using archiver.
// Both pipe file data from disk through the encoder to the HTTP
// response — memory stays flat regardless of archive size.
//
// The BLOCKLIST is enforced via a manual walk + archive.file/append
// loop, because archiver v7's directory() ignores the filter/glob
// options (we tested).
// ============================================================
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { BLOCKLIST } = require('../config');
const { isBlockedName, sanitizeFilename } = require('./paths');
const log = require('../log');

/**
 * Walk a directory and add entries to the archive, skipping
 * blocklisted names (.env, .git, node_modules, .chunks, etc.).
 */
function walkAndAdd(archive, dir, prefix) {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    if (isBlockedName(item)) continue;
    const full = path.join(dir, item);
    const rel = prefix ? `${prefix}/${item}` : item;
    try {
      const s = fs.statSync(full);
      if (s.isDirectory()) {
        archive.append('', { name: `${rel}/`, type: 'directory' });
        walkAndAdd(archive, full, rel);
      } else {
        archive.file(full, { name: rel, stats: s });
      }
    } catch (e) { /* skip deleted */ }
  }
}

/**
 * Stream a ZIP of `filePath` to `res`. Sets appropriate headers.
 * Calls `onError(err)` if the archive fails (caller usually sends 500).
 *
 * @param {object} res       Express response
 * @param {string} filePath  Absolute path to file or directory
 * @param {object} req       Express request (for abort handling)
 */
function streamZip(res, filePath, req) {
  const baseName = path.basename(filePath);
  const stat = fs.statSync(filePath);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(baseName)}.zip"`);
  res.setHeader('Transfer-Encoding', 'chunked');

  const archive = archiver('zip', { store: true });
  archive.on('error', (err) => {
    log.error('ZIP stream error:', { message: err.message });
    if (!res.headersSent) res.status(500).send(`Zip error: ${err.message}\n`);
    archive.destroy();
  });
  archive.on('warning', (err) => log.warn('ZIP stream warning:', { message: err.message }));

  archive.pipe(res);
  req.on('close', () => { if (!archive.destroyed) archive.abort(); });

  if (stat.isDirectory()) {
    walkAndAdd(archive, filePath, baseName);
  } else {
    archive.file(filePath, { name: baseName });
  }
  archive.finalize();
}

/**
 * Stream a TAR.GZ of `filePath` to `res`.
 */
function streamTar(res, filePath, req) {
  const baseName = path.basename(filePath);
  const stat = fs.statSync(filePath);

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(baseName)}.tar.gz"`);
  res.setHeader('Transfer-Encoding', 'chunked');

  const archive = archiver('tar', { gzip: true, gzipOptions: { level: 6 } });
  archive.on('error', (err) => {
    log.error('TAR stream error:', { message: err.message });
    if (!res.headersSent) res.status(500).send(`Tar error: ${err.message}\n`);
    archive.destroy();
  });
  archive.on('warning', (err) => log.warn('TAR stream warning:', { message: err.message }));

  archive.pipe(res);
  req.on('close', () => { if (!archive.destroyed) archive.abort(); });

  if (stat.isDirectory()) {
    walkAndAdd(archive, filePath, baseName);
  } else {
    archive.file(filePath, { name: baseName });
  }
  archive.finalize();
}

module.exports = { streamZip, streamTar };
