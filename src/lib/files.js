// ============================================================
// lib/files.js — Recursive directory scanning + formatting helpers.
// Used by /api/files, /api/find, /api/tree, and the root listing.
// ============================================================
const fs = require('fs');
const path = require('path');
const { SHARED_DIR } = require('../config');
const { isHiddenName } = require('./paths');

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Recursively scan a directory tree (async, doesn't block event loop).
 * Uses readdir({ withFileTypes: true }) so we get the entry type in
 * 1 syscall (N+1 total per directory, was 2N before v2.4.0).
 *
 * @param {string} dir          Absolute path to scan
 * @param {number} maxDepth     Cap recursion (default 20)
 * @param {number} currentDepth Used internally for recursion
 * @param {boolean} showChunks  Reveal .chunks/ entries
 * @returns {Promise<Array>}    Flat list of {name, type, size, ...}
 */
async function getFilesRecursive(dir, maxDepth = 20, currentDepth = 0, showChunks = false) {
  if (currentDepth > maxDepth) return [];
  let results = [];
  try {
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const d of dirents) {
      if (isHiddenName(d.name, showChunks)) continue;
      const filePath = path.join(dir, d.name);
      try {
        let isDir;
        try { isDir = d.isDirectory(); }
        catch { isDir = (await fs.promises.stat(filePath)).isDirectory(); }
        const stat = await fs.promises.stat(filePath);
        const relativeToShared = path.relative(SHARED_DIR, filePath);

        if (isDir) {
          results.push({
            name: d.name, type: 'dir', size: stat.size,
            formattedSize: '-',
            modified: stat.mtime.toISOString().replace('T', ' ').substring(0, 16),
            path: relativeToShared,
          });
          const subResults = await getFilesRecursive(filePath, maxDepth, currentDepth + 1, showChunks);
          results = results.concat(subResults);
        } else {
          results.push({
            name: d.name, type: 'file', size: stat.size,
            formattedSize: formatBytes(stat.size),
            modified: stat.mtime.toISOString().replace('T', ' ').substring(0, 16),
            path: relativeToShared,
          });
        }
      } catch (e) { /* file deleted concurrently */ }
    }
  } catch (e) {
    // log import would create a cycle; caller can wrap if needed.
  }
  return results;
}

/**
 * Sort files: directories first, then alphabetical by name.
 * Mutates a copy; safe to call on the result of getFilesRecursive.
 */
function sortFiles(files) {
  return [...files].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

module.exports = { formatBytes, getFilesRecursive, sortFiles };
