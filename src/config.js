// ============================================================
// config.js — Central configuration loaded from env vars.
// All magic constants live here so other modules import from
// one place. Changing a default = changing it here.
// ============================================================
const path = require('path');
require('dotenv').config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const SHARED_DIR = path.resolve(process.env.SHARED_DIR || './shared');
const CHUNK_DIR = path.join(SHARED_DIR, '.chunks');

const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || (95 * 1024 * 1024).toString(), 10);
const MAX_TOTAL_SIZE = parseInt(
  process.env.MAX_TOTAL_SIZE || (10 * 1024 * 1024 * 1024).toString(), 10
);
const MAX_AGE_HOURS = parseInt(process.env.CHUNK_MAX_AGE_HOURS || '24', 10);

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '100', 10);

// Files/dirs always hidden + inaccessible regardless of route.
const BLOCKLIST = new Set([
  '.env', '.git', '.gitignore', 'node_modules',
  '.chunks', '.DS_Store', 'Thumbs.db',
]);

// Items that ?showChunks=1 can reveal (subset of BLOCKLIST).
const REVEALABLE = new Set(['.chunks']);

const HEADLESS_BIN = process.env.HEADLESS_BIN || '/home/z/bin/headless';
const HEADLESS_MONITOR_ENABLED = process.env.HEADLESS_MONITOR_ENABLED !== 'false';

const PKG_VERSION = (() => {
  try { return require('../package.json').version || 'unknown'; }
  catch { return 'unknown'; }
})();

module.exports = {
  PORT, SHARED_DIR, CHUNK_DIR,
  CHUNK_SIZE, MAX_TOTAL_SIZE, MAX_AGE_HOURS,
  RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX,
  BLOCKLIST, REVEALABLE,
  HEADLESS_BIN, HEADLESS_MONITOR_ENABLED,
  PKG_VERSION,
};
