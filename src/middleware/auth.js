// ============================================================
// middleware/auth.js — Bearer token + Basic auth (for WebDAV clients).
//
// Accepts the token via:
//   - Authorization: Bearer <token>          (all methods)
//   - Authorization: Basic <base64(user:token)>  (WebDAV clients)
//   - ?token=<token>                          (GET only, for shareable URLs)
//
// On 401 for WebDAV paths (/webdav, /dav) emits WWW-Authenticate: Basic
// so clients like Dolphin prompt for credentials.
// ============================================================
const { SHARED_DIR } = require('../config');

function isWebDAVPath(req) {
  // Inside a router mounted at /webdav or /dav, req.path is the path
  // RELATIVE to the mount point. We must check req.baseUrl + req.path
  // and also req.originalUrl (always the full URL Express received).
  const fullPath = (req.baseUrl || '') + (req.path || '');
  if (fullPath.startsWith('/webdav') || fullPath.startsWith('/dav')) return true;
  const orig = req.originalUrl || '';
  return orig.startsWith('/webdav') || orig.startsWith('/dav');
}

function authenticate(req, res, next) {
  const token = process.env.AUTH_TOKEN;
  if (!token) return next();

  let clientToken = null;

  if (req.method === 'GET') {
    clientToken = req.query.token;
  }

  if (!clientToken && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts[0] === 'Bearer') {
      clientToken = parts[1];
    } else if (parts[0] === 'Basic') {
      // WebDAV clients only support Basic/Digest — accept it where
      // username is ignored and password carries the AUTH_TOKEN.
      try {
        const decoded = Buffer.from(parts[1], 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        if (idx >= 0) clientToken = decoded.substring(idx + 1);
      } catch (e) { /* invalid base64 — fall through to 401 */ }
    }
  }

  if (clientToken === token) return next();

  // Build 401 response tailored to the client type.
  const isCurl = req.headers['user-agent'] && req.headers['user-agent'].includes('curl');
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');

  if (isWebDAVPath(req)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="FileVault", charset="UTF-8"');
  }

  if (wantsJson) {
    return res.status(401).json({ error: 'Unauthorized. Invalid or missing token.' });
  }
  if (isCurl) {
    return res.status(401).send('Unauthorized. Use: curl -H "Authorization: Bearer <token>" ...\n');
  }
  return res.status(401).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Access Denied</title>
      <style>
        body { background-color:#0f0f13;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0; }
        .container { background:#1a1a24;padding:2.5rem;border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,0.4);text-align:center;max-width:380px;width:100%;border:1px solid #2e2e3f; }
        h2 { margin-top:0;color:#f8fafc;font-weight:600; }
        p { color:#94a3b8;font-size:0.95rem;margin-bottom:1.5rem; }
        input { width:100%;padding:12px;border-radius:6px;border:1px solid #3f3f50;background:#0f0f13;color:#fff;margin-bottom:1.25rem;box-sizing:border-box;font-size:1rem; }
        input:focus { outline:2px solid #6366f1;border-color:transparent; }
        button { background:#6366f1;border:none;color:white;padding:12px;border-radius:6px;cursor:pointer;font-weight:600;width:100%;font-size:1rem;transition:background 0.2s; }
        button:hover { background:#4f46e5; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>Authentication Required</h2>
        <p>This file transfer server is protected. Please enter the access token.</p>
        <input type="password" id="token" placeholder="Access Token" autofocus>
        <button onclick="submitToken()">Submit</button>
      </div>
      <script>
        function submitToken() {
          const token = document.getElementById('token').value;
          if (token) {
            const url = new URL(window.location.href);
            url.searchParams.set('token', token);
            window.location.href = url.toString();
          }
        }
        document.getElementById('token').addEventListener('keypress', function(e) {
          if (e.key === 'Enter') submitToken();
        });
      </script>
    </body>
    </html>
  `);
}

module.exports = { authenticate, isWebDAVPath };
