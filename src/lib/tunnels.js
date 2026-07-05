// ============================================================
// lib/tunnels.js — Cloudflare / localtunnel / zrok starters.
// Each starter is async and resolves once the tunnel URL is logged.
// On failure, starters fall back to the next provider.
// ============================================================
const fs = require('fs');
const log = require('../log');

function startCloudflare(PORT) {
  return async () => {
    try {
      log.info('Requesting Cloudflare tunnel...');
      const { bin, install, Tunnel } = require('cloudflared');
      if (!fs.existsSync(bin)) {
        log.info('Installing cloudflared binary...');
        await install(bin);
      }
      let lastUrl = null;
      const cfTunnel = Tunnel.quick(`http://localhost:${PORT}`);
      cfTunnel.once('url', (url) => {
        lastUrl = url;
        log.info('Cloudflare Tunnel active', { url });
      });
      cfTunnel.once('error', (err) => log.error('Cloudflare Tunnel error:', { message: err.message }));
      cfTunnel.once('exit', (code) => log.warn('Cloudflare Tunnel exited', { code }));
      // Healthcheck — logs a warning if no URL after 30s.
      setInterval(() => {
        if (!lastUrl) log.warn('Tunnel healthcheck: no URL established yet');
      }, 30000);
    } catch (err) {
      log.error('Could not initialize Cloudflare Tunnel:', { message: err.message });
    }
  };
}

function startLocaltunnel(PORT) {
  return async () => {
    try {
      log.info('Requesting localtunnel...');
      const localtunnel = require('localtunnel');
      const tunnel = await localtunnel({
        port: PORT,
        subdomain: process.env.SUBDOMAIN || undefined,
      });
      if (tunnel.url) log.info('Localtunnel active', { url: tunnel.url });
      tunnel.on('close', () => {
        log.warn('Localtunnel closed. Trying Cloudflare...');
        startCloudflare(PORT)();
      });
      tunnel.on('error', (err) => {
        log.error('Localtunnel error:', { message: err.message });
        startCloudflare(PORT)();
      });
    } catch (err) {
      log.error('Could not initialize localtunnel:', { message: err.message });
      await startCloudflare(PORT)();
    }
  };
}

function startZrok(PORT) {
  return () => {
    try {
      const { spawn } = require('child_process');
      const zrok = spawn('zrok', ['share', 'public', `http://localhost:${PORT}`]);
      let success = false;
      const timeout = setTimeout(() => {
        if (!success) {
          try { zrok.kill(); } catch (e) {}
          startLocaltunnel(PORT)();
        }
      }, 15000);
      zrok.stdout.on('data', (data) => {
        const m = data.toString().match(/https?:\/\/[a-z0-9.-]+\.share\.zrok\.io/i);
        if (m) {
          success = true;
          clearTimeout(timeout);
          log.info('zrok Tunnel active', { url: m[0] });
        }
      });
      zrok.on('error', () => startLocaltunnel(PORT)());
      zrok.on('exit', () => startLocaltunnel(PORT)());
    } catch (e) {
      startLocaltunnel(PORT)();
    }
  };
}

/**
 * Start the tunnel provider selected via TUNNEL_PROVIDER env var.
 * Falls back to localtunnel → cloudflare chain on failure.
 */
function startTunnel(PORT) {
  if (process.env.LOCAL_ONLY === 'true') {
    log.info('Local-Only mode. Tunnels disabled.');
    return;
  }
  const provider = (process.env.TUNNEL_PROVIDER || 'cloudflare').toLowerCase();
  if (provider === 'cloudflare' || provider === 'cf') startCloudflare(PORT)();
  else if (provider === 'zrok') startZrok(PORT)();
  else startLocaltunnel(PORT)();
}

module.exports = { startTunnel };
