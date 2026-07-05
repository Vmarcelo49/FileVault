# FileVault

> Self-hosted file transfer server with chunked uploads, automatic Cloudflare tunneling, WebDAV support, and a glassmorphic dark-mode web UI.

**Version 2.4.0** · Node ≥ 18 · MIT

Exposes a folder on your machine to the internet via **Cloudflare Tunnel** (default), **localtunnel**, or **zrok**, with a web dashboard for browsers, a plain-text API for `curl`, and a WebDAV server for mounting in Dolphin / Finder / Windows Explorer.

---

## Quickstart (for agents)

The deterministic path from zero to a public URL. Every step is copy-pasteable.

### 1. Clone + install

```bash
cd /home/z/my-project
git clone https://github.com/Vmarcelo49/FileVault.git
cd FileVault
npm install
```

`npm install` is also auto-run by `daemon.py` if `node_modules/` is missing, but doing it up front surfaces errors earlier.

### 2. Generate AUTH_TOKEN

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the 64-char hex string. **Never reuse a token across machines.**

### 3. Write `.env`

```bash
cat > /home/z/my-project/FileVault/.env <<'EOF'
PORT=3000
SHARED_DIR=/home/z/my-project/
LOCAL_ONLY=false
TUNNEL_PROVIDER=cloudflare
AUTH_TOKEN=<paste-the-64-char-token-here>
EOF
chmod 600 /home/z/my-project/FileVault/.env
```

Critical fields:

| Field | Value | Notes |
|---|---|---|
| `SHARED_DIR` | `/home/z/my-project/` | The folder exposed. Must end with `/`. Created if missing. |
| `AUTH_TOKEN` | 64-char hex | Required for public tunnels. Empty = no auth (DO NOT leave empty on a tunnel). |
| `TUNNEL_PROVIDER` | `cloudflare` | One of `cloudflare`, `localtunnel`, `zrok`. |
| `LOCAL_ONLY` | `false` | `true` skips tunnel entirely (localhost only). |

### 4. Start the server (with public tunnel)

```bash
python3 /home/z/my-project/FileVault/daemon.py start-filevault
```

This spawns `npm start` detached via a double-fork, so it survives the shell session ending. The daemon auto-runs `npm install` if `node_modules/` is missing.

> **Do not use `npm start` directly** if you need the tunnel to persist across shell sessions — it dies when the parent shell exits. Always go through `daemon.py`.

### 5. Wait for the tunnel URL

The Cloudflare tunnel takes ~4-8 seconds to come up. Poll the logs:

```bash
python3 /home/z/my-project/FileVault/daemon.py logs filevault 30
```

Look for the line:

```
[INFO] Cloudflare Tunnel active {"url":"https://<random-name>.trycloudflare.com"}
```

Extract just the URL programmatically:

```bash
python3 /home/z/my-project/FileVault/daemon.py logs filevault 100 \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
```

### 6. Validate

```bash
URL="<the-tunnel-url>"
TOKEN="<the-token-from-.env>"

# Health (no auth required)
curl -s "$URL/api/health"
# Expected: {"status":"ok","uptime":N,"version":"2.4.0","authEnabled":true}

# Auth check
curl -s -o /dev/null -w "%{http_code}\n" "$URL/"
# Expected: 401

# Authenticated list
curl -s -H "Authorization: Bearer $TOKEN" "$URL/" | head -5

# WebDAV
curl -s -o /dev/null -w "%{http_code}\n" -X PROPFIND -H "Depth: 1" \
  -u "user:$TOKEN" "$URL/webdav/"
# Expected: 207
```

If all four pass, the server is up and reachable. Report `$URL` and `$TOKEN` to the operator.

---

## Daemon commands

`daemon.py` is the only supported way to manage the server process. All commands:

```bash
python3 daemon.py start-filevault              # public tunnel mode (default)
python3 daemon.py start-filevault local        # local-only mode (no tunnel)
python3 daemon.py stop filevault
python3 daemon.py restart filevault
python3 daemon.py status filevault [--json]
python3 daemon.py list [--json]
python3 daemon.py logs filevault [N]           # last N lines (default 30)
python3 daemon.py kill-all                     # stop everything
```

State files live in `~/.filevault/daemons/` (PID, log, cmd, meta). Override with `FILEVAULT_DAEMONS_DIR=/path python3 daemon.py ...`.

The generic `start` form (for running anything, not just FileVault):

```bash
python3 daemon.py start <name> <command...> [--cwd DIR] [--env K=V ...]
```

---

## Configuration reference (.env)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Local port the server binds to. |
| `SHARED_DIR` | `./shared` | Root directory served. Created if missing. |
| `AUTH_TOKEN` | _(empty)_ | Bearer token. **Always set for public tunnels.** |
| `TUNNEL_PROVIDER` | `cloudflare` | `cloudflare` \| `localtunnel` \| `zrok` |
| `LOCAL_ONLY` | `false` | If `true`, skip all tunnels. |
| `SUBDOMAIN` | _(empty)_ | Request a specific localtunnel subdomain. |
| `CHUNK_SIZE` | `95 MB` | Max chunk size for chunked uploads (bytes). |
| `MAX_TOTAL_SIZE` | `10 GB` | Hard limit per uploaded file (bytes). |
| `CHUNK_MAX_AGE_HOURS` | `24` | Stale chunk sessions cleaned up after this. |
| `RATE_LIMIT_MAX` | `100` | Max requests per minute per IP on `/api/*` and `/upload/*`. |
| `WEBDAV_VERBOSE_LOG` | `false` | Log every WebDAV request (verbose; off by default). |
| `HEADLESS_BIN` | `/home/z/bin/headless` | Path to HeadlessLab CLI (for live view). |
| `HEADLESS_MONITOR_ENABLED` | `true` | Set `false` to disable live view feature. |

---

## Authentication

If `AUTH_TOKEN` is set, every request needs it. Two ways to send:

- **Header** (all methods): `Authorization: Bearer <token>`
- **Query param** (GET only): `?token=<token>`

WebDAV clients (Dolphin, Finder, Windows Explorer) only support HTTP Basic auth, so the server also accepts `Authorization: Basic <base64(user:token)>` where the username is ignored and the password carries the token. On 401, WebDAV paths emit `WWW-Authenticate: Basic realm="FileVault"` so clients prompt for credentials.

---

## WebDAV (mount in Dolphin / Finder / Explorer)

The WebDAV server is mounted at `/webdav` with an alias at `/dav`.

```
webdavs://<tunnel-url>/webdav/
webdavs://<tunnel-url>/dav/        # shorter alias
```

Login dialog: username = anything (ignored), password = `AUTH_TOKEN`.

Supported methods (RFC 4918): `OPTIONS`, `PROPFIND` (Depth 0/1/infinity), `PROPPATCH` (stub), `GET`, `HEAD`, `PUT`, `DELETE`, `MKCOL`, `COPY`, `MOVE`, `LOCK` (stub), `UNLOCK` (stub).

The same `AUTH_TOKEN` works for both the REST API and WebDAV. Blocklist (`.env`, `.git`, `node_modules`, `.chunks`, `.DS_Store`, `Thumbs.db`) is enforced on every path.

PROPFIND responses include `ETag`, `Last-Modified`, and `Cache-Control: private, max-age=60, must-revalidate` so clients can cache directory listings between navigations.

---

## API reference (curl)

All endpoints require `Authorization: Bearer $TOK` (or `?token=$TOK` on GET).

### Listings

```bash
curl -H "Authorization: Bearer $TOK" "$URL/"
curl -H "Authorization: Bearer $TOK" "$URL/?recursive=1"
curl -H "Authorization: Bearer $TOK" "$URL/ls/docs"
curl -H "Authorization: Bearer $TOK" "$URL/api/files?path=docs"
curl -H "Authorization: Bearer $TOK" "$URL/api/tree?path=docs&depth=3"
curl -H "Authorization: Bearer $TOK" "$URL/api/find?q=*.js"
```

### Read / write

```bash
curl -H "Authorization: Bearer $TOK" -O "$URL/files/docs/todo.txt"
curl -X POST -H "Authorization: Bearer $TOK" --data-binary "content" \
  "$URL/api/write/docs/todo.txt"
curl -X POST -H "Authorization: Bearer $TOK" "$URL/api/touch/docs/empty.txt"
curl -X POST -H "Authorization: Bearer $TOK" "$URL/api/mkdir/docs/sub"
```

### Move / copy / delete

```bash
curl -X PATCH -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"from":"docs/a.txt","to":"docs/b.txt"}' "$URL/api/mv"

curl -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"from":"docs/a.txt","to":"backup/a.txt"}' "$URL/api/cp"
# Add ?force=1 to overwrite existing destination

curl -X DELETE -H "Authorization: Bearer $TOK" "$URL/files/docs/old"
```

### Archives (streamed, zero memory buffering)

```bash
curl -H "Authorization: Bearer $TOK" -o files.zip "$URL/api/zip/docs"
curl -H "Authorization: Bearer $TOK" -o files.tar.gz "$URL/api/tar/docs"
```

Both use the `archiver` package and stream file data from disk through the encoder to the response. Blocklist is enforced — `.git/`, `.env`, `node_modules/` are never included.

### Stats & hashes

```bash
curl -H "Authorization: Bearer $TOK" "$URL/api/stat/docs/todo.txt"
curl -H "Authorization: Bearer $TOK" "$URL/api/du/docs"
curl -H "Authorization: Bearer $TOK" "$URL/api/df"
curl -H "Authorization: Bearer $TOK" "$URL/api/sha256/docs/todo.txt"
curl -H "Authorization: Bearer $TOK" "$URL/api/md5/docs/todo.txt"
curl -H "Authorization: Bearer $TOK" "$URL/api/wc/docs/todo.txt"
curl -H "Authorization: Bearer $TOK" "$URL/api/head/docs/log.txt?lines=50"
curl -H "Authorization: Bearer $TOK" "$URL/api/tail/docs/log.txt?lines=50"
```

### Chunked uploads (files > 95 MB)

```bash
./chunked-upload.sh ./big.tar.gz "$URL" "$TOK" [destination_subfolder]
```

Or manually:

```bash
# 1. Init session
curl -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"uploadId":"upl-1","fileName":"big.tar.gz","totalSize":123456789,"totalChunks":2}' \
  "$URL/upload/chunk/init"

# 2. Upload each chunk (multipart/form-data, field "file")
curl -X POST -H "Authorization: Bearer $TOK" \
  -F "file=@chunk_0" -F "uploadId=upl-1" -F "chunkIndex=0" -F "totalChunks=2" \
  "$URL/upload/chunk"

# 3. Last chunk auto-finalizes — server assembles the file via streaming pipe
```

Inspect active sessions:

```bash
curl -H "Authorization: Bearer $TOK" "$URL/api/uploads"
curl -H "Authorization: Bearer $TOK" "$URL/upload/chunk/status?uploadId=upl-1"
curl -X DELETE -H "Authorization: Bearer $TOK" "$URL/upload/chunk?uploadId=upl-1"
```

---

## Project layout

```
FileVault/
├── server.js              # Express server (routes, auth, chunked upload, tunnels)
├── webdav.js              # WebDAV router (mounted at /webdav and /dav)
├── daemon.py              # Double-fork daemon spawner
├── chunked-upload.sh      # Bash client for chunked uploads
├── package.json
├── .env.example
├── public/                # Static frontend (vanilla JS, ES modules)
│   ├── index.html
│   ├── live.html          # Live view page (HeadlessLab integration)
│   ├── css/styles.css
│   └── js/
│       ├── api.js         # API client wrapper
│       ├── app.js         # Bootstrap
│       ├── state.js       # Global store
│       ├── utils.js       # Helpers (escapeHtml, formatBytes, etc.)
│       └── components/
│           ├── browser.js # File list + breadcrumbs
│           ├── tree.js    # Sidebar tree
│           ├── drawer.js  # Details drawer
│           ├── upload.js  # Upload queue
│           ├── search.js  # Search modal
│           ├── modals.js  # New folder / file / rename / copy modals
│           └── mobile.js  # Bottom tabs for mobile
└── shared/                # Served root (created on first run)
    └── .chunks/           # Active chunked uploads (hidden by default)
```

---

## Troubleshooting (deterministic fixes)

### `EADDRINUSE: address already in use 0.0.0.0:3000`

A previous server is still holding the port. Kill it:

```bash
python3 /home/z/my-project/FileVault/daemon.py stop filevault
pkill -f "node server.js"   # kill orphans
sleep 2
ss -ltnp 2>/dev/null | grep :3000 || echo "port free"
```

Then `start-filevault` again.

### Tunnel URL not appearing in logs

The Cloudflare tunnel takes 4-8 seconds. If after 15s there's no `Cloudflare Tunnel active` line:

```bash
python3 /home/z/my-project/FileVault/daemon.py logs filevault 50
```

Look for `Could not initialize Cloudflare Tunnel`. Causes:
- Outbound HTTPS blocked (firewall / proxy)
- `cloudflared` binary failed to download (the `cloudflared` npm package auto-installs it on first run)

Fallback: set `TUNNEL_PROVIDER=localtunnel` in `.env` and restart.

### WebDAV client can't open the folder

Three common causes, all already fixed in v2.4.0 but check if running older:

1. **No `WWW-Authenticate` header on 401** → client doesn't prompt for credentials. Fixed in v2.4.0.
2. **`PROPFIND /webdav/` returns 404** → root collection wasn't resolving. Fixed in v2.4.0.
3. **Duplicate folder names in listing** → `req.baseUrl` bug when same router mounted at `/webdav` + `/dav`. Fixed in v2.4.0.

If on v2.4.0+ and still failing, check `WEBDAV_VERBOSE_LOG=1` in `.env`, restart, reproduce, then `daemon.py logs filevault 200` to see the request trace.

### OOM on `/api/zip` or `/api/tar`

Fixed in v2.4.0 — archives now stream via `archiver`. If you see OOM, you're on an older version. Update.

### Chunked upload `meta.json` out of sync

Fixed in v2.4.0 — per-uploadId mutex (`withUploadLock`) serializes concurrent chunks. If you see `receivedChunks` not matching disk reality on an older version, update.

### `daemon.py restart` breaks on paths with spaces

Fixed in v2.4.0 — uses `shlex.split` + `shlex.quote`. On older versions, the naive `split(' ')` corrupted `--cwd /home/z/my dir`.

### Server starts but `/api/health` returns old version

The version is read from `package.json` at startup (v2.4.0+). If it shows the wrong value, restart the daemon — `package.json` is only read at boot.

---

## Live View (optional — requires HeadlessLab)

FileVault integrates with [HeadlessLab](https://github.com/Vmarcelo49/HeadlessLab) to display a live screen capture of a Wine session in the browser. Opt-in; never runs automatically.

| Env var | Default | Description |
|---|---|---|
| `HEADLESS_BIN` | `/home/z/bin/headless` | Path to the `headless` CLI binary. |
| `HEADLESS_MONITOR_ENABLED` | `true` | Set `false` to disable the feature entirely. |

API:

```bash
curl -H "Authorization: Bearer $TOK" "$URL/api/monitors"
curl -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"session_id":"sess_...","out_path":"live.png","interval":"5s"}' \
  "$URL/api/monitors/start"
curl -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"session_id":"sess_..."}' "$URL/api/monitors/stop"
```

Web UI: click the 📺 button in the topbar (or visit `/live?token=...`).

---

## Security notes

- **Always set `AUTH_TOKEN` before exposing a public tunnel.** Empty token = no auth, anyone on the internet can read/write your `SHARED_DIR`.
- **`.env` is in `.gitignore`** — never commit it.
- **Blocklist** (`.env`, `.git`, `node_modules`, `.chunks`, `.DS_Store`, `Thumbs.db`) is enforced on every route including WebDAV and archives. Path traversal is validated on every request.
- **Rate limiting**: 100 req/min/IP on `/api/*` and `/upload/*`. WebDAV paths are NOT rate-limited (clients like Dolphin make many small requests).
- **Chunked uploads** are idempotent — the `X-Idempotent: true` response header signals that retrying the same chunk is safe.

---

## Changelog

### v2.4.0
- **Security fix**: XSS in `modals.js` — `store.state.currentPath` (from `?path=` URL param) was interpolated into `innerHTML` without escaping in the "Nova pasta" and "Novo arquivo" modals. Now wrapped with `escapeHtml()`.
- **Streaming fix**: `/api/zip` and `/api/tar` now stream via the `archiver` package instead of building the entire archive in RAM. Previously caused OOM on large folders.
- **Streaming fix**: `finalizeChunkedUpload` now pipes chunk files via `fs.createReadStream` instead of `readFileSync` per chunk. Memory stays flat regardless of file size.
- **Race fix**: chunked upload now serializes per-`uploadId` via `withUploadLock()`. Concurrent chunks no longer clobber `meta.json`.
- **Perf**: `getFilesRecursive` uses `readdir({ withFileTypes: true })` — 2N→N+1 syscalls per directory.
- **Perf**: `/api/find` caches the file index for 30s (or until `SHARED_DIR` mtime changes). 50× faster on repeat searches.
- **Perf**: `copyDir` is now async — no longer blocks the event loop on large recursive copies.
- **Fix**: `daemon.py restart` now uses `shlex.split` — survives paths with spaces.
- **Fix**: `daemon.py start-filevault` no longer prints a partial `AUTH_TOKEN` (was leaking 37% of the token; now shows only `****{last4}`).
- **Fix**: `chunked-upload.sh` now parses JSON with `python3` instead of `grep -q '"success":true'` (brittle against minified output).
- **Fix**: `/api/health` reads version from `package.json` dynamically (was hardcoded to `2.2.0`).

### v2.3.0
- WebDAV server mounted at `/webdav` (alias `/dav`).
- `WWW-Authenticate: Basic` header on 401 for WebDAV paths (so Dolphin prompts for login).
- Root collection (`PROPFIND /webdav/`) resolves to `SHARED_DIR` instead of 404.
- Fixed duplicate folder names in PROPFIND hrefs (caused by `req.baseUrl` bug when same router is mounted at multiple paths).
- WebDAV logging moved behind `WEBDAV_VERBOSE_LOG` env var (off by default — was flooding logs).
- PROPFIND responses include `ETag`, `Last-Modified`, `Cache-Control` for client-side caching.
- Live View feature with HeadlessLab integration.

### v2.2.0
- Chunked uploads from the browser now send `Authorization: Bearer` header (was only `?token=` in query, which the server rejects on POST).
- `?showChunks=1` query param reveals the `.chunks/` folder.
- `GET /api/uploads` lists all chunked upload sessions with progress.
- Web UI toggle `👁 chunks` in the toolbar.
- Multer errors translated to descriptive JSON `{error, code, hint}`.

### v2.1.0
- Content-Disposition default is `inline` (use `?download=1` for attachment).
- `/api/health` no longer leaks the absolute `sharedDir` path.
- UTF-8 filenames preserved (only `/`, `\`, and control chars blocked).
- `/api/cp` returns 409 if destination exists (use `?force=1` to overwrite).
- SHA-256 / MD5 streamed in 64 KB chunks.
- `/api/head` and `/api/tail` use streaming.
- Rate limiting, CORS, path traversal validation, graceful shutdown.

---

## License

MIT © [Vmarcelo49](https://github.com/Vmarcelo49)
