// ============================================================
// lib/paths.js — Path traversal protection + filename sanitization.
// All routes resolve user-supplied paths through getSafePath; the
// blocklist check guarantees that .env / .git / node_modules / etc.
// can never be reached regardless of the route.
// ============================================================
const path = require('path');
const { SHARED_DIR, BLOCKLIST, REVEALABLE } = require('../config');

/**
 * Resolves `filename` inside SHARED_DIR and rejects anything escaping.
 * Also rejects any path whose any component is in BLOCKLIST.
 * Returns the absolute safe path, or null on violation.
 *
 * Note: returns null for empty filename. Callers that need the root
 * collection (e.g. PROPFIND /webdav/) should handle empty input
 * themselves by resolving to SHARED_DIR.
 */
function getSafePath(filename) {
  if (!filename) return null;
  const safePath = path.resolve(SHARED_DIR, filename);
  if (safePath !== SHARED_DIR && !safePath.startsWith(SHARED_DIR + path.sep)) {
    return null;
  }
  const parts = path.relative(SHARED_DIR, safePath).split(path.sep);
  for (const p of parts) {
    if (BLOCKLIST.has(p)) return null;
  }
  return safePath;
}

/**
 * Sanitize a filename for safe storage on disk.
 * Keeps UTF-8 (accents, unicode) — only blocks path separators and
 * control chars (0x00-0x1F, 0x7F).
 */
function sanitizeFilename(name) {
  const baseName = path.basename(name || '');
  return baseName.replace(/[\/\\]/g, '_').replace(/[\x00-\x1f\x7f]/g, '');
}

function isBlockedName(name) {
  return BLOCKLIST.has(name);
}

/**
 * True if `name` is blocked AND cannot be revealed by ?showChunks=1.
 * REVEALABLE items (.chunks) become visible when showChunks=true.
 */
function isHiddenName(name, showChunks = false) {
  if (!BLOCKLIST.has(name)) return false;
  if (showChunks && REVEALABLE.has(name)) return false;
  return true;
}

module.exports = { getSafePath, sanitizeFilename, isBlockedName, isHiddenName };
