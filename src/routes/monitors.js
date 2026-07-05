// ============================================================
// routes/monitors.js — HeadlessLab live view integration.
// Calls the external `headless` CLI to list/start/stop live-screen
// monitors. Caches /api/monitors for 2s.
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { SHARED_DIR, HEADLESS_BIN, HEADLESS_MONITOR_ENABLED } = require('../config');
const { formatBytes } = require('../lib/files');
const { authenticate } = require('../middleware/auth');
const log = require('../log');

const router = express.Router();

let _monitorsCache = null;
let _monitorsCacheAt = 0;

function notAvailable(res, msg, extra = {}) {
  return res.status(503).json({
    error: msg,
    headless_available: false,
    monitors: [],
    total: 0,
    active: 0,
    ...extra,
  });
}

router.get('/api/monitors', authenticate, async (req, res) => {
  if (!HEADLESS_MONITOR_ENABLED) {
    return notAvailable(res, 'Monitor integration disabled (HEADLESS_MONITOR_ENABLED=false)');
  }
  if (!fs.existsSync(HEADLESS_BIN)) {
    return notAvailable(res, `headless CLI not found at ${HEADLESS_BIN}`);
  }

  const now = Date.now();
  if (_monitorsCache && (now - _monitorsCacheAt) < 2000) {
    return res.json(_monitorsCache);
  }

  try {
    const env = { ...process.env, APPDIR: process.env.APPDIR || '/home/z/my-project/squashfs-root' };
    execFile(HEADLESS_BIN, ['monitor', 'status'], {
      timeout: 5000, env, cwd: process.env.HOME || '/home/z',
    }, (err, stdout, stderr) => {
      if (err) {
        log.error('Monitor status exec error:', { message: err.message, stderr: stderr?.substring(0, 200) });
        const fallback = {
          status: 'ok', headless_available: true,
          total: 0, active: 0, monitors: [], error: err.message,
        };
        _monitorsCache = fallback;
        _monitorsCacheAt = now;
        return res.json(fallback);
      }
      try {
        const parsed = JSON.parse(stdout);
        const result = {
          ...parsed,
          headless_available: true,
          monitors: (parsed.monitors || []).map(m => {
            try {
              const outPath = m.out_path;
              if (outPath && fs.existsSync(outPath)) {
                const stat = fs.statSync(outPath);
                return {
                  ...m,
                  out_size: stat.size,
                  out_size_formatted: formatBytes(stat.size),
                  out_mtime: stat.mtime.toISOString(),
                  out_age_ms: now - stat.mtimeMs,
                };
              }
              return m;
            } catch { return m; }
          }),
        };
        _monitorsCache = result;
        _monitorsCacheAt = now;
        return res.json(result);
      } catch (parseErr) {
        log.error('Monitor status parse error:', { message: parseErr.message, stdout: stdout.substring(0, 200) });
        return res.status(500).json({
          error: 'Failed to parse headless output',
          stdout: stdout.substring(0, 500),
          stderr: stderr?.substring(0, 500),
        });
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/api/monitors/start', authenticate, express.json({ limit: '1mb' }), async (req, res) => {
  if (!HEADLESS_MONITOR_ENABLED) {
    return res.status(503).json({ error: 'Monitor integration disabled' });
  }
  const { session_id, out_path, interval, quality, skip_identical } = req.body || {};
  if (!session_id || !out_path) {
    return res.status(400).json({
      error: 'Missing required fields: session_id, out_path',
      code: 'MISSING_FIELDS',
    });
  }
  const finalOutPath = path.isAbsolute(out_path) ? out_path : path.resolve(SHARED_DIR, out_path);
  if (!finalOutPath.startsWith(SHARED_DIR + path.sep) && finalOutPath !== SHARED_DIR) {
    return res.status(403).json({
      error: 'out_path must be inside the shared directory (so it can be served by FileVault)',
      code: 'OUT_PATH_OUTSIDE_SHARED',
      shared_dir: SHARED_DIR,
      out_path: finalOutPath,
    });
  }

  try {
    const args = ['monitor', 'start', '--session', session_id, '--out', finalOutPath];
    if (interval) args.push('--interval', String(interval));
    if (quality) args.push('--quality', String(quality));
    if (skip_identical === false) args.push('--no-skip-identical');

    const env = { ...process.env, APPDIR: process.env.APPDIR || '/home/z/my-project/squashfs-root' };
    execFile(HEADLESS_BIN, args, {
      timeout: 10000, env, cwd: process.env.HOME || '/home/z',
    }, (err, stdout, stderr) => {
      if (err) {
        log.error('Monitor start exec error:', { message: err.message, stderr: stderr?.substring(0, 200) });
        try {
          const parsed = JSON.parse(stdout || '{}');
          return res.status(400).json(parsed);
        } catch {
          return res.status(500).json({
            error: err.message,
            stdout: stdout?.substring(0, 500),
            stderr: stderr?.substring(0, 500),
          });
        }
      }
      try {
        const parsed = JSON.parse(stdout);
        _monitorsCache = null; // invalidate
        return res.json(parsed);
      } catch (parseErr) {
        return res.status(500).json({
          error: 'Failed to parse headless output',
          stdout: stdout.substring(0, 500),
        });
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/api/monitors/stop', authenticate, express.json({ limit: '1mb' }), async (req, res) => {
  if (!HEADLESS_MONITOR_ENABLED) {
    return res.status(503).json({ error: 'Monitor integration disabled' });
  }
  const { session_id } = req.body || {};
  try {
    const args = ['monitor', 'stop'];
    if (session_id) args.push('--session', session_id);
    const env = { ...process.env, APPDIR: process.env.APPDIR || '/home/z/my-project/squashfs-root' };
    execFile(HEADLESS_BIN, args, {
      timeout: 10000, env, cwd: process.env.HOME || '/home/z',
    }, (err, stdout, stderr) => {
      if (err) {
        log.error('Monitor stop exec error:', { message: err.message });
        try {
          const parsed = JSON.parse(stdout || '{}');
          return res.status(400).json(parsed);
        } catch {
          return res.status(500).json({ error: err.message });
        }
      }
      try {
        const parsed = JSON.parse(stdout);
        _monitorsCache = null;
        return res.json(parsed);
      } catch (parseErr) {
        return res.status(500).json({ error: 'Failed to parse headless output' });
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
