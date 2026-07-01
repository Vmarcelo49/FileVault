# FileVault

> Self-hosted file transfer server with chunked uploads, automatic tunneling, and a glassmorphic dark-mode web UI.

[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.2.0-purple)](#)

Expose a folder on your machine to the internet via **Cloudflare Tunnel** (default), **localtunnel**, or **zrok**, with a clean web dashboard for browsers and a script-friendly plain-text API for `curl`.

## ✨ Features

- **Web UI (browser)** — responsive three-panel layout: tree explorer, file browser, details drawer. Mobile-friendly with bottom tabs.
- **CLI/cURL API** — plain-text output for scripting: list, upload, download, mkdir, mv, cp, rm, stat, du, df, sha256, md5, zip, tar.
- **Chunked uploads** — automatic for files >95 MB (browser splits in 90 MB chunks; server reassembles).
- **Multiple tunnels** — Cloudflare Tunnel (default, fast), localtunnel (fallback), zrok (optional).
- **Auth** — single bearer token, accepted via `Authorization` header (all methods) or `?token=` query (GET only).
- **Visibility toggle** — `.chunks/` folder is hidden by default but can be revealed in the UI to inspect active upload sessions.
- **Descriptive errors** — multer errors (`LIMIT_FILE_SIZE`, `LIMIT_UNEXPECTED_FILE`, …) are translated to JSON with `{error, code, hint}`.
- **Daemon helper** — `daemon.py` keeps the server alive across shell sessions using a double-fork.

## 🚀 Quick Start

```bash
git clone https://github.com/Vmarcelo49/FileVault.git
cd FileVault
npm install
cp .env.example .env
# Generate a secure token
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Paste it as AUTH_TOKEN in .env, then:
npm start
```

The server prints the public tunnel URL on boot. Open it in a browser with `?token=<your_token>` to load the UI already authenticated.

### Local-only mode (no public tunnel)

```bash
npm run local
```

Useful for testing on `http://localhost:3000`.

## 🔧 Configuration (.env)

| Variable            | Default       | Description                                              |
| ------------------- | ------------- | ------------------------------------------------------- |
| `PORT`              | `3000`        | Port the local server binds to.                         |
| `SHARED_DIR`        | `./shared`    | Root directory served. Created if missing.              |
| `SUBDOMAIN`         | _(empty)_     | Request a specific subdomain from localtunnel.          |
| `LOCAL_ONLY`        | `false`       | If `true`, do not start any tunnel.                     |
| `TUNNEL_PROVIDER`   | `cloudflare`  | One of: `cloudflare`, `localtunnel`, `zrok`.            |
| `AUTH_TOKEN`        | _(empty)_     | Bearer token. **Always set this for public tunnels.**   |
| `CHUNK_SIZE`        | `95 MB`       | Max chunk size for chunked uploads.                     |
| `MAX_TOTAL_SIZE`    | `10 GB`       | Hard limit on total upload size per file.               |
| `CHUNK_MAX_AGE_HOURS` | `24`        | Stale chunk sessions are cleaned up after this.         |
| `RATE_LIMIT_MAX`    | `100`         | Max requests per minute per IP on `/api/*` and `/upload/*`. |

## 🧑‍💻 CLI / cURL Reference

If `AUTH_TOKEN` is set, authenticate with either:
- Header: `-H "Authorization: Bearer <token>"`
- Query (GET only): `?token=<token>`

### Listings
```bash
curl -H "Authorization: Bearer $TOK" "$URL/"
curl -H "Authorization: Bearer $TOK" "$URL/?recursive=1"
curl -H "Authorization: Bearer $TOK" "$URL/ls/docs/vacation"
```

### Read / Write
```bash
curl -H "Authorization: Bearer $TOK" -O "$URL/files/docs/todo.txt"
curl -X POST -H "Authorization: Bearer $TOK" --data-binary "content" "$URL/api/write/docs/todo.txt"
curl -X POST -H "Authorization: Bearer $TOK" "$URL/api/touch/docs/empty.txt"
```

### Move / Copy / Delete
```bash
curl -X PATCH -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"from":"docs/a.txt","to":"docs/b.txt"}' "$URL/api/mv"

curl -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"from":"docs/a.txt","to":"backup/a.txt"}' "$URL/api/cp"

curl -X DELETE -H "Authorization: Bearer $TOK" "$URL/files/docs/old"
```

### Archives
```bash
curl -H "Authorization: Bearer $TOK" -o files.zip "$URL/api/zip/docs"
curl -H "Authorization: Bearer $TOK" -o files.tar.gz "$URL/api/tar/docs"
```

### Stats & Hashes
```bash
curl -H "Authorization: Bearer $TOK" "$URL/api/stat/docs/todo.txt"
curl -H "Authorization: Bearer $TOK" "$URL/api/du/docs"
curl -H "Authorization: Bearer $TOK" "$URL/api/df"
curl -H "Authorization: Bearer $TOK" "$URL/api/sha256/docs/todo.txt"
```

### Chunked Uploads (large files >100 MB)
```bash
./chunked-upload.sh ./big.tar.gz "$URL" "$TOK" [destination_subfolder]
```
The browser UI performs chunked uploads automatically when a file exceeds 95 MB.

### Inspecting active uploads
```bash
# List all chunked upload sessions (active + recently finalized)
curl -H "Authorization: Bearer $TOK" "$URL/api/uploads"

# Show progress for a specific session
curl -H "Authorization: Bearer $TOK" "$URL/upload/chunk/status?uploadId=<id>"

# Cancel and clean up
curl -X DELETE -H "Authorization: Bearer $TOK" "$URL/upload/chunk?uploadId=<id>"
```

In the web UI, click the `👁 chunks` button in the toolbar to reveal the `.chunks/` folder. Clicking on a `meta.json` inside shows a parsed progress view with a "Cancel and clean up" button.

## 🐍 Daemon helper (`daemon.py`)

Spawn the server detached from your shell session — survives logout, terminal close, and ephemeral shells.

```bash
# Start FileVault via daemon (auto-runs npm install if missing)
python3 daemon.py start-filevault            # public tunnel mode
python3 daemon.py start-filevault local      # local-only mode

# Generic daemon commands
python3 daemon.py start <name> <command...> [--cwd DIR] [--env K=V ...]
python3 daemon.py status <name> [--json]
python3 daemon.py list [--json]
python3 daemon.py logs <name> [lines]
python3 daemon.py restart <name>
python3 daemon.py stop <name>
python3 daemon.py kill-all
```

State files live in `/home/z/my-project/daemons/` (PID, log, cmd, meta). Edit `STATE_DIR` near the top of `daemon.py` if you want a different location.

## 🧱 Project layout

```
FileVault/
├── server.js              # Express server (routes, auth, chunked upload, tunnels)
├── daemon.py              # Double-fork daemon spawner
├── chunked-upload.sh      # Bash client for chunked uploads
├── package.json
├── .env.example
├── README.md
├── LICENSE
├── public/                # Static frontend (vanilla JS, ES modules)
│   ├── index.html
│   ├── css/styles.css
│   └── js/
│       ├── api.js
│       ├── app.js
│       ├── state.js
│       ├── utils.js
│       └── components/
│           ├── browser.js
│           ├── tree.js
│           ├── drawer.js
│           ├── upload.js
│           ├── search.js
│           ├── mobile.js
│           └── modals.js
└── shared/                # Served root (created on first run)
    └── .chunks/           # Active chunked uploads (hidden by default)
```

## 🔒 Security notes

- Always set `AUTH_TOKEN` before exposing a public tunnel.
- The server blocks `.env`, `.git`, `node_modules`, `.chunks`, `.DS_Store`, `Thumbs.db` from listing and access.
- `.chunks/` can be revealed in the UI with the `👁 chunks` toggle (read-only inspection, never writable through the API).
- Path traversal is validated on every route.
- Rate limiting: 100 req/min/IP on `/api/*` and `/upload/*` (configurable).

## 📝 Changelog

### v2.2.0
- **Fix**: chunked uploads from the browser now send `Authorization: Bearer` header (previously only `?token=` in query, which the server rejects on POST). This was the root cause of chunked uploads failing silently with 0/N chunks received.
- **Feat**: `?showChunks=1` query param on `/api/files` reveals the `.chunks/` folder.
- **Feat**: new `GET /api/uploads` endpoint lists all chunked upload sessions with progress.
- **Feat**: web UI toggle `👁 chunks` in the toolbar.
- **Feat**: clicking a `.chunks/<id>/meta.json` in the UI shows a parsed progress view with a "Cancel and clean up" button.
- **Feat**: multer errors (`LIMIT_FILE_SIZE`, `LIMIT_UNEXPECTED_FILE`, etc.) now return descriptive JSON with `{error, code, hint}`.
- **Feat**: upload failures open a modal with HTTP status, error code, server message, and a "Try again" button.

### v2.1.0
- Content-Disposition default is `inline` (use `?download=1` for attachment).
- `/api/health` no longer leaks the absolute `sharedDir` path.
- UTF-8 filenames preserved (only `/`, `\`, and control chars are blocked).
- `/api/cp` returns 409 if destination exists (use `?force=1` to overwrite).
- `/api/find` returns relative paths.
- SHA-256 / MD5 streamed in 64 KB chunks.
- `/api/head` and `/api/tail` use streaming (no full file in memory).
- `/api/zip` and `/api/tar` stream output.
- Rate limiting, CORS, path traversal validation, graceful shutdown.

## 📄 License

MIT © [Vmarcelo49](https://github.com/Vmarcelo49)
