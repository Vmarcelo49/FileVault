/**
 * FileVault WebDAV Module
 *
 * Mounts a WebDAV server on top of the existing FileVault Express app.
 * Compatible with Dolphin (KDE), Finder (macOS), Windows Explorer,
 * Nautilus, Thunar, and other WebDAV clients.
 *
 * Uses the same AUTH_TOKEN-based authentication as the rest of FileVault.
 * The shared `authenticate` middleware accepts both Bearer tokens and
 * HTTP Basic Auth (username ignored, password = AUTH_TOKEN), since most
 * WebDAV clients only support Basic/Digest.
 *
 * Supported WebDAV methods (RFC 4918):
 *   - OPTIONS, PROPFIND, PROPPATCH (stub)
 *   - GET, HEAD, PUT, DELETE
 *   - MKCOL, COPY, MOVE
 *   - LOCK, UNLOCK (stub — fake lock tokens for mount compatibility)
 *
 * Notes:
 *   - PUT streams the body to disk (no in-memory buffering).
 *   - PROPFIND supports Depth: 0, 1, infinity (capped at 20 levels).
 *   - COPY/MOVE require a Destination header on the same host.
 *   - LOCK returns a fresh opaque lock token but does not enforce it.
 *     This is sufficient for single-user file serving and lets clients
 *     like Dolphin mount the share (they require LOCK support even
 *     if they never use it for editing).
 *   - Blocklist (.env, .git, .chunks, etc.) is enforced via getSafePath
 *     and an additional check on the destination of COPY/MOVE.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function createWebDAVRouter(opts) {
  const { SHARED_DIR, getSafePath, authenticate, log, BLOCKLIST } = opts;
  const router = express.Router();

  // ============================================================
  // Helpers
  // ============================================================

  function xmlEscape(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Build the WebDAV href for a resource.
   * Directories end with '/' per RFC 4918.
   */
  function buildHref(baseUrl, relPath, isDir) {
    const cleanRel = (relPath || '').replace(/^\/+|\/+$/g, '');
    let href;
    if (cleanRel) {
      const encoded = cleanRel.split('/').map(encodeURIComponent).join('/');
      href = `${baseUrl}/${encoded}`;
    } else {
      href = baseUrl + '/';
    }
    if (isDir && !href.endsWith('/')) href += '/';
    return href;
  }

  function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.htm': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.mjs': 'application/javascript',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.gz': 'application/gzip',
      '.tar': 'application/x-tar',
      '.tgz': 'application/x-tar',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.csv': 'text/csv',
      '.md': 'text/markdown',
      '.log': 'text/plain',
      '.yml': 'text/yaml',
      '.yaml': 'text/yaml',
      '.toml': 'text/plain',
      '.ini': 'text/plain',
      '.conf': 'text/plain',
      '.sh': 'text/x-shellscript',
      '.py': 'text/x-python',
      '.js': 'application/javascript',
      '.ts': 'application/javascript',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf',
    };
    return types[ext] || 'application/octet-stream';
  }

  function isPathBlocked(relPath) {
    const parts = (relPath || '').split('/');
    for (const p of parts) {
      if (BLOCKLIST.has(p)) return true;
    }
    return false;
  }

  function etagFor(stat) {
    return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  }

  /**
   * Build a single <D:response> element for PROPFIND/PROPPATCH.
   */
  function buildPropResponse(relPath, stat, baseUrl, isDir) {
    const href = buildHref(baseUrl, relPath, isDir);
    const displayname = path.basename(relPath) || '/';
    const lastmod = stat.mtime.toUTCString();
    const etag = etagFor(stat);
    const mime = isDir ? 'httpd/unix-directory' : getMimeType(relPath);

    let prop = '';
    prop += `        <D:displayname>${xmlEscape(displayname)}</D:displayname>\n`;
    prop += `        <D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>\n`;
    if (!isDir) {
      prop += `        <D:getcontentlength>${stat.size}</D:getcontentlength>\n`;
      prop += `        <D:getcontenttype>${xmlEscape(mime)}</D:getcontenttype>\n`;
    }
    prop += `        <D:getlastmodified>${lastmod}</D:getlastmodified>\n`;
    prop += `        <D:getetag>${etag}</D:getetag>\n`;
    prop += `        <D:supportedlock>\n`;
    prop += `          <D:lockentry>\n`;
    prop += `            <D:lockscope><D:exclusive/></D:lockscope>\n`;
    prop += `            <D:locktype><D:write/></D:locktype>\n`;
    prop += `          </D:lockentry>\n`;
    prop += `        </D:supportedlock>\n`;

    return `  <D:response>
    <D:href>${xmlEscape(href)}</D:href>
    <D:propstat>
      <D:prop>
${prop}      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
  }

  /**
   * Walk a directory recursively (capped at maxDepth) collecting entries.
   * Skips BLOCKLIST names.
   */
  function walkRecursive(relPath, absPath, entries, depth, maxDepth) {
    if (depth > maxDepth) return;
    try {
      const names = fs.readdirSync(absPath);
      for (const name of names) {
        if (BLOCKLIST.has(name)) continue;
        const childAbs = path.join(absPath, name);
        const childRel = relPath ? `${relPath}/${name}` : name;
        try {
          const childStat = fs.statSync(childAbs);
          const childIsDir = childStat.isDirectory();
          entries.push({ relPath: childRel, stat: childStat, isDir: childIsDir });
          if (childIsDir) walkRecursive(childRel, childAbs, entries, depth + 1, maxDepth);
        } catch (e) { /* file deleted concurrently */ }
      }
    } catch (e) { /* permission error or similar */ }
  }

  /**
   * Parse the Destination header from COPY/MOVE.
   * Returns { relPath } on success, or { error } on failure.
   */
  function parseDestination(req) {
    const dest = req.headers.destination;
    if (!dest) return { error: 'missing Destination header' };
    try {
      const url = new URL(dest);
      let p = url.pathname;
      const baseUrl = req.webdavBaseUrl || req.baseUrl || '/webdav';
      // Strip the baseUrl prefix
      if (p === baseUrl) {
        return { relPath: '' };
      }
      if (!p.startsWith(baseUrl + '/')) {
        return { error: `destination not under ${baseUrl}` };
      }
      const relPath = decodeURIComponent(p.substring(baseUrl.length)).replace(/^\/+|\/+$/g, '');
      return { relPath };
    } catch (e) {
      return { error: 'invalid Destination URL' };
    }
  }

  // ============================================================
  // Auth — same middleware used by the rest of FileVault
  // (extended in server.js to accept HTTP Basic Auth)
  // ============================================================
  router.use(authenticate);

  // ============================================================
  // Dispatch all WebDAV methods on the wildcard path
  // ============================================================
  router.use('/*', (req, res, next) => {
    // Strip trailing slash for path resolution (we re-add it for dirs in hrefs)
    const relPath = (req.params[0] || '').replace(/\/+$/, '');
    const safePath = getSafePath(relPath);

    // Compute the WebDAV base URL once: it's the prefix that was stripped by
    // Express when mounting the router. req.baseUrl gives us that, but when
    // the router is mounted at multiple paths (/webdav and /dav), we need to
    // use the actual matched mount point — req.baseUrl is correct here.
    // We pass it through req.webdavBaseUrl so handlers don't have to recompute.
    req.webdavBaseUrl = req.baseUrl || '/webdav';

    log.info('WebDAV request', {
      method: req.method,
      originalUrl: req.originalUrl,
      baseUrl: req.baseUrl,
      path: req.path,
      params0: req.params[0],
      relPath,
      webdavBaseUrl: req.webdavBaseUrl,
    });

    switch (req.method) {
      case 'OPTIONS':    return handleOptions(req, res, relPath, safePath);
      case 'PROPFIND':   return handlePropfind(req, res, relPath, safePath);
      case 'MKCOL':      return handleMkcol(req, res, relPath, safePath);
      case 'GET':        return handleGet(req, res, relPath, safePath);
      case 'HEAD':       return handleHead(req, res, relPath, safePath);
      case 'PUT':        return handlePut(req, res, relPath, safePath);
      case 'DELETE':     return handleDelete(req, res, relPath, safePath);
      case 'COPY':       return handleCopy(req, res, relPath, safePath);
      case 'MOVE':       return handleMove(req, res, relPath, safePath);
      case 'PROPPATCH':  return handleProppatch(req, res, relPath, safePath);
      case 'LOCK':       return handleLock(req, res, relPath, safePath);
      case 'UNLOCK':     return handleUnlock(req, res, relPath, safePath);
      default:
        return res.status(501).send('Not Implemented');
    }
  });

  // ============================================================
  // Handlers
  // ============================================================

  function handleOptions(req, res, relPath, safePath) {
    res.set({
      'DAV': '1, 2',
      'MS-Author-Via': 'DAV',
      'Allow': 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, PROPFIND, PROPPATCH, LOCK, UNLOCK',
      'Content-Length': '0',
    });
    return res.status(200).end();
  }

  function handlePropfind(req, res, relPath, safePath) {
    if (!safePath || !fs.existsSync(safePath)) {
      return res.status(404).send('Not Found');
    }

    const depth = (req.headers.depth || '1').toLowerCase();
    const stat = fs.statSync(safePath);
    const isDir = stat.isDirectory();
    const baseUrl = req.webdavBaseUrl || req.baseUrl || '/webdav';

    const entries = [{ relPath, stat, isDir }];

    if (isDir && depth !== '0') {
      if (depth === 'infinity') {
        walkRecursive(relPath, safePath, entries, 0, 20);
      } else {
        // Depth: 1 — immediate children only
        try {
          const names = fs.readdirSync(safePath);
          for (const name of names) {
            if (BLOCKLIST.has(name)) continue;
            const childAbs = path.join(safePath, name);
            const childRel = relPath ? `${relPath}/${name}` : name;
            try {
              const childStat = fs.statSync(childAbs);
              entries.push({
                relPath: childRel,
                stat: childStat,
                isDir: childStat.isDirectory(),
              });
            } catch (e) { /* skip */ }
          }
        } catch (e) { /* skip */ }
      }
    }

    const responses = entries
      .map(e => buildPropResponse(e.relPath, e.stat, baseUrl, e.isDir))
      .join('\n');

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${responses}
</D:multistatus>`;

    res.set({
      'Content-Type': 'application/xml; charset=utf-8',
      'DAV': '1, 2',
    });
    return res.status(207).send(xml);
  }

  function handleMkcol(req, res, relPath, safePath) {
    if (!safePath) return res.status(400).send('Bad Request');
    if (isPathBlocked(relPath)) return res.status(403).send('Forbidden');
    if (fs.existsSync(safePath)) return res.status(405).send('Method Not Allowed');

    const parent = path.dirname(safePath);
    if (!fs.existsSync(parent)) {
      return res.status(409).send('Conflict: parent directory does not exist');
    }

    try {
      fs.mkdirSync(safePath);
      return res.status(201).end();
    } catch (err) {
      return res.status(500).send(`Internal Server Error: ${err.message}`);
    }
  }

  function handleGet(req, res, relPath, safePath) {
    if (!safePath || !fs.existsSync(safePath)) {
      return res.status(404).send('Not Found');
    }
    const stat = fs.statSync(safePath);
    if (stat.isDirectory()) {
      // GET on a collection — return 403. Clients use PROPFIND for listings.
      return res.status(403).send('Forbidden: GET on collection not supported');
    }
    res.setHeader('Content-Type', getMimeType(relPath));
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('ETag', etagFor(stat));
    res.setHeader('Accept-Ranges', 'bytes');
    return res.sendFile(safePath);
  }

  function handleHead(req, res, relPath, safePath) {
    if (!safePath || !fs.existsSync(safePath)) {
      return res.status(404).end();
    }
    const stat = fs.statSync(safePath);
    if (stat.isDirectory()) {
      res.setHeader('Content-Type', 'httpd/unix-directory');
      res.setHeader('Last-Modified', stat.mtime.toUTCString());
      return res.status(200).end();
    }
    res.setHeader('Content-Type', getMimeType(relPath));
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('ETag', etagFor(stat));
    res.setHeader('Accept-Ranges', 'bytes');
    return res.status(200).end();
  }

  function handlePut(req, res, relPath, safePath) {
    if (!safePath) return res.status(400).send('Bad Request');
    if (isPathBlocked(relPath)) return res.status(403).send('Forbidden');

    if (fs.existsSync(safePath) && fs.statSync(safePath).isDirectory()) {
      return res.status(409).send('Conflict: cannot PUT to a collection');
    }
    const parent = path.dirname(safePath);
    if (!fs.existsSync(parent)) {
      return res.status(409).send('Conflict: parent directory does not exist');
    }

    const existed = fs.existsSync(safePath);
    const writeStream = fs.createWriteStream(safePath);

    writeStream.on('error', (err) => {
      log.error('WebDAV PUT error', { path: relPath, message: err.message });
      if (!res.headersSent) {
        return res.status(500).send(`Internal Server Error: ${err.message}`);
      }
    });

    writeStream.on('close', () => {
      try {
        const stat = fs.statSync(safePath);
        res.setHeader('ETag', etagFor(stat));
      } catch (e) { /* file may have been removed */ }
      return res.status(existed ? 204 : 201).end();
    });

    req.pipe(writeStream);
  }

  function handleDelete(req, res, relPath, safePath) {
    if (!safePath || !fs.existsSync(safePath)) {
      return res.status(404).send('Not Found');
    }
    if (isPathBlocked(relPath)) return res.status(403).send('Forbidden');
    try {
      fs.rmSync(safePath, { recursive: true, force: true });
      return res.status(204).end();
    } catch (err) {
      return res.status(500).send(`Internal Server Error: ${err.message}`);
    }
  }

  function handleCopy(req, res, srcRel, srcAbs) {
    if (!srcAbs || !fs.existsSync(srcAbs)) {
      return res.status(404).send('Not Found');
    }
    const dest = parseDestination(req);
    if (!dest || dest.error) {
      return res.status(400).send(`Bad Request: ${dest?.error || 'invalid Destination'}`);
    }
    const destAbs = getSafePath(dest.relPath);
    if (!destAbs) return res.status(400).send('Bad Request: invalid destination path');
    if (isPathBlocked(dest.relPath)) return res.status(403).send('Forbidden');

    const overwrite = (req.headers.overwrite || 'T').toUpperCase() !== 'F';
    const existed = fs.existsSync(destAbs);

    if (existed && !overwrite) {
      return res.status(412).send('Precondition Failed');
    }
    if (existed) {
      try { fs.rmSync(destAbs, { recursive: true, force: true }); }
      catch (e) { return res.status(500).send(`Error overwriting: ${e.message}`); }
    }

    const parentDir = path.dirname(destAbs);
    if (!fs.existsSync(parentDir)) {
      return res.status(409).send('Conflict: parent directory does not exist');
    }

    try {
      if (fs.statSync(srcAbs).isDirectory()) {
        fs.cpSync(srcAbs, destAbs, { recursive: true });
      } else {
        fs.copyFileSync(srcAbs, destAbs);
      }
      return res.status(existed ? 204 : 201).end();
    } catch (err) {
      return res.status(500).send(`Internal Server Error: ${err.message}`);
    }
  }

  function handleMove(req, res, srcRel, srcAbs) {
    if (!srcAbs || !fs.existsSync(srcAbs)) {
      return res.status(404).send('Not Found');
    }
    const dest = parseDestination(req);
    if (!dest || dest.error) {
      return res.status(400).send(`Bad Request: ${dest?.error || 'invalid Destination'}`);
    }
    const destAbs = getSafePath(dest.relPath);
    if (!destAbs) return res.status(400).send('Bad Request: invalid destination path');
    if (isPathBlocked(dest.relPath)) return res.status(403).send('Forbidden');

    const overwrite = (req.headers.overwrite || 'T').toUpperCase() !== 'F';
    const existed = fs.existsSync(destAbs);

    if (existed && !overwrite) {
      return res.status(412).send('Precondition Failed');
    }
    if (existed) {
      try { fs.rmSync(destAbs, { recursive: true, force: true }); }
      catch (e) { return res.status(500).send(`Error overwriting: ${e.message}`); }
    }

    const parentDir = path.dirname(destAbs);
    if (!fs.existsSync(parentDir)) {
      return res.status(409).send('Conflict: parent directory does not exist');
    }

    try {
      fs.renameSync(srcAbs, destAbs);
      return res.status(existed ? 204 : 201).end();
    } catch (err) {
      // Cross-device rename — fallback to copy + delete
      if (err.code === 'EXDEV') {
        try {
          if (fs.statSync(srcAbs).isDirectory()) {
            fs.cpSync(srcAbs, destAbs, { recursive: true });
            fs.rmSync(srcAbs, { recursive: true, force: true });
          } else {
            fs.copyFileSync(srcAbs, destAbs);
            fs.unlinkSync(srcAbs);
          }
          return res.status(existed ? 204 : 201).end();
        } catch (e) {
          return res.status(500).send(`Internal Server Error: ${e.message}`);
        }
      }
      return res.status(500).send(`Internal Server Error: ${err.message}`);
    }
  }

  function handleProppatch(req, res, relPath, safePath) {
    if (!safePath || !fs.existsSync(safePath)) {
      return res.status(404).send('Not Found');
    }
    // Stub: we don't store custom DAV properties.
    // Return 200 OK for any property operation requested.
    const baseUrl = req.webdavBaseUrl || req.baseUrl || '/webdav';
    const stat = fs.statSync(safePath);
    const isDir = stat.isDirectory();
    const href = buildHref(baseUrl, relPath, isDir);

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${xmlEscape(href)}</D:href>
    <D:propstat>
      <D:prop/>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

    res.set('Content-Type', 'application/xml; charset=utf-8');
    return res.status(207).send(xml);
  }

  function handleLock(req, res, relPath, safePath) {
    if (!safePath) return res.status(400).send('Bad Request');

    // If the resource doesn't exist, treat LOCK as a "create empty" (null lock)
    const existed = fs.existsSync(safePath);
    if (!existed) {
      const parent = path.dirname(safePath);
      if (!fs.existsSync(parent)) {
        return res.status(409).send('Conflict: parent directory does not exist');
      }
      try { fs.writeFileSync(safePath, ''); }
      catch (e) { return res.status(500).send(`Error creating resource: ${e.message}`); }
    }

    const stat = fs.statSync(safePath);
    const isDir = stat.isDirectory();
    const baseUrl = req.webdavBaseUrl || req.baseUrl || '/webdav';
    const href = buildHref(baseUrl, relPath, isDir);
    const lockToken = `opaquelocktoken:${crypto.randomUUID()}`;
    const timeout = req.headers.timeout || 'Second-3600';
    const depth = req.headers.depth || 'infinity';

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>${xmlEscape(depth)}</D:depth>
      <D:timeout>${xmlEscape(timeout)}</D:timeout>
      <D:owner>${xmlEscape(req.headers.owner || 'filevault')}</D:owner>
      <D:locktoken>
        <D:href>${xmlEscape(lockToken)}</D:href>
      </D:locktoken>
      <D:lockroot>
        <D:href>${xmlEscape(href)}</D:href>
      </D:lockroot>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`;

    res.set({
      'Content-Type': 'application/xml; charset=utf-8',
      'Lock-Token': `<${lockToken}>`,
    });
    return res.status(existed ? 200 : 201).send(xml);
  }

  function handleUnlock(req, res, relPath, safePath) {
    // Stub: always succeed (we don't actually track locks)
    return res.status(204).end();
  }

  return router;
};
