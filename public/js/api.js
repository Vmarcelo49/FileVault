// ============================================================
// api.js — Camada de comunicação com o server
// Todos os endpoints em um só lugar, com auth transparente
// ============================================================

import { getAuthToken } from './state.js';

// Read fresh from storage on each call (token may have been cleared)
function currentToken() {
  return getAuthToken();
}

function buildUrl(path, params = {}) {
  const url = new URL(path, window.location.origin);
  // Token is NEVER put in the URL anymore — it's always sent via
  // Authorization header. This avoids token leakage in browser history,
  // shared links, screenshots, etc.
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  return url.toString();
}

function buildHeaders(extra = {}) {
  const h = { ...extra };
  const token = currentToken();
  if (token && !h.Authorization) h.Authorization = `Bearer ${token}`;
  return h;
}

/**
 * Build a URL that includes the token as a query param.
 * Used ONLY for resources loaded via <a href> / <img src> / window.open()
 * where we can't set the Authorization header. The token still appears in
 * the URL but only for these specific resource fetches, not for page
 * navigation.
 */
function buildAuthedUrl(path, params = {}) {
  const url = new URL(path, window.location.origin);
  const token = currentToken();
  if (token) url.searchParams.set('token', token);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  return url.toString();
}

async function request(path, options = {}, params = {}) {
  const url = buildUrl(path, params);
  const opts = { ...options };
  opts.headers = buildHeaders(opts.headers || {});

  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, opts);
  return res;
}

// ============================================================
// Endpoints agrupados por domínio
// ============================================================

export const api = {
  // ===== Health / System =====
  health: () => request('/api/health').then(r => r.ok ? r.json() : null),
  pwd: () => request('/api/pwd').then(r => r.ok ? r.json() : null),
  df: () => request('/api/df').then(r => r.ok ? r.json() : null),

  // ===== Listagem =====
  listFiles: (path = '', opts = {}) => {
    const params = { path };
    if (opts.showChunks) params.showChunks = '1';
    if (opts.recursive) params.recursive = '1';
    return request('/api/files', {}, params).then(r => r.json());
  },
  listFilesRaw: (path = '') => request('/', {}, { path }).then(r => r.text()),
  tree: (path = '', depth = 4) => request('/api/tree', {}, { path, depth }).then(r => r.json()),
  find: (q) => request('/api/find', {}, { q }).then(r => r.json()),

  // ===== Uploads em chunk ativos =====
  listUploads: (includeFinalized = false) =>
    request('/api/uploads', {}, includeFinalized ? { includeFinalized: '1' } : {}).then(r => r.ok ? r.json() : { sessions: [], total: 0 }),
  cancelUpload: (uploadId) =>
    request('/upload/chunk', { method: 'DELETE' }, { uploadId }).then(r => r.json()),

  // ===== Metadados =====
  stat: (path) => request(`/api/stat/${encPath(path)}`).then(r => r.ok ? r.json() : null),
  du: (path) => request(`/api/du/${encPath(path)}`).then(r => r.ok ? r.json() : null),
  wc: (path) => request(`/api/wc/${encPath(path)}`).then(r => r.ok ? r.json() : null),
  fileInfo: (path) => request(`/api/file/${encPath(path)}`).then(r => r.ok ? r.json() : null),

  // ===== Hashes =====
  sha256: (path) => request(`/api/sha256/${encPath(path)}`).then(r => r.ok ? r.json() : null),
  md5: (path) => request(`/api/md5/${encPath(path)}`).then(r => r.ok ? r.json() : null),

  // ===== Leitura =====
  head: (path, lines = 50) => request(`/api/head/${encPath(path)}`, {}, { lines }).then(r => r.ok ? r.text() : ''),
  tail: (path, lines = 50) => request(`/api/tail/${encPath(path)}`, {}, { lines }).then(r => r.ok ? r.text() : ''),

  // ===== Criação =====
  mkdir: (path) => request(`/api/mkdir/${encPath(path)}`, { method: 'POST' }).then(r => ({ ok: r.ok, text: r.text() })),
  touch: (path) => request(`/api/touch/${encPath(path)}`, { method: 'POST' }).then(r => ({ ok: r.ok, text: r.text() })),
  write: (path, content) => request(`/api/write/${encPath(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: content
  }).then(r => ({ ok: r.ok, text: r.text() })),

  // ===== Copiar / Mover =====
  cp: (from, to) => request('/api/cp', {
    method: 'POST',
    body: { from, to }
  }).then(r => ({ ok: r.ok, text: r.text() })),
  mv: (from, to) => request('/api/mv', {
    method: 'PATCH',
    body: { from, to }
  }).then(r => ({ ok: r.ok, text: r.text() })),

  // ===== Delete =====
  delete: (path) => request(`/files/${encPath(path)}`, { method: 'DELETE' })
    .then(r => ({ ok: r.ok, text: r.text() })),

  // ===== Upload simples =====
  uploadSimple: (file, path = '') => {
    const formData = new FormData();
    formData.append('file', file);
    return request('/upload' + (path ? '/' + encPath(path) : ''), {
      method: 'POST',
      body: formData
    });
  },

  // ===== Upload em chunks =====
  chunkInit: (uploadId, fileName, totalSize, totalChunks) =>
    request('/upload/chunk/init', {
      method: 'POST',
      body: { uploadId, fileName, totalSize, totalChunks }
    }).then(r => r.json()),

  chunkSend: (uploadId, chunkIndex, totalChunks, fileName, totalSize, chunkBlob) => {
    const formData = new FormData();
    formData.append('file', chunkBlob, fileName);
    formData.append('uploadId', uploadId);
    formData.append('chunkIndex', chunkIndex);
    formData.append('totalChunks', totalChunks);
    formData.append('fileName', fileName);
    formData.append('totalSize', totalSize);
    return request('/upload/chunk', { method: 'POST', body: formData });
  },

  chunkStatus: (uploadId) =>
    request('/upload/chunk/status', {}, { uploadId }).then(r => r.json()),

  chunkCancel: (uploadId) =>
    request('/upload/chunk', { method: 'DELETE' }, { uploadId }).then(r => r.json()),

  // ===== Download URLs (não-fetch, para <a download>, <img>, window.open) =====
  // Estes ainda precisam do token na URL porque <a>/<img> não suportam headers.
  // Mas o token NÃO aparece na barra de endereço — só no network tab.
  downloadUrl: (path) => buildAuthedUrl(`/files/${encPath(path)}`),
  inlineUrl: (path) => buildAuthedUrl(`/files/${encPath(path)}`, { inline: '1' }),
  zipUrl: (path) => buildAuthedUrl(`/api/zip/${encPath(path)}`),
  tarUrl: (path) => buildAuthedUrl(`/api/tar/${encPath(path)}`),
};

function encPath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

// Helper pra construir query string (sem token — token vai no header)
export function getQuery(extra = {}) {
  const params = { ...extra };
  const s = new URLSearchParams(params).toString();
  return s ? `?${s}` : '';
}

// Helper pra uploads via XHR que precisam setar o header Authorization manualmente
export function authHeader() {
  const t = currentToken();
  return t ? `Bearer ${t}` : null;
}

export function getAuthTokenValue() {
  return currentToken();
}
