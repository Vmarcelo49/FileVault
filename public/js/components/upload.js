// ============================================================
// components/upload.js — Upload simples + chunked + drag&drop
// ============================================================

import { api, authHeader } from '../api.js';
import { store } from '../state.js';
import { escapeHtml, formatBytes, showToast } from '../utils.js';
import { loadFiles } from './browser.js';
import { loadTree } from './tree.js';
import { openModal, closeModal } from './modals.js';

const uploadQueue = [];

export function initUpload() {
  const input = document.getElementById('upload-input');
  if (input) {
    input.onchange = () => {
      handleFileSelect(input.files);
      input.value = '';  // reset para permitir re-upar mesmo arquivo
    };
  }

  // Drag & drop no browser
  const browser = document.querySelector('[data-panel="browser"]');
  const dropOverlay = document.getElementById('drop-overlay');
  if (!browser || !dropOverlay) return;

  ['dragenter', 'dragover'].forEach(ev => {
    browser.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        dropOverlay.classList.add('show');
        const path = document.getElementById('drop-path');
        if (path) path.textContent = '/' + (store.state.currentPath || '');
      }
    });
  });
  browser.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && browser.contains(e.relatedTarget)) return;
    dropOverlay.classList.remove('show');
  });
  browser.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropOverlay.classList.remove('show');
    const files = Array.from(e.dataTransfer.files);
    if (files.length) handleFileSelect(files);
  });
}

export function handleFileSelect(fileList) {
  for (const file of fileList) {
    uploadQueue.push({
      file, progress: 0, status: 'pending',
      name: file.name, speed: '', error: null, chunkInfo: null
    });
  }
  showUploadList();
  processUploadQueue();
}

function showUploadList() {
  document.getElementById('upload-list').classList.add('show');
  renderUploadList();
}

export function hideUploadList() {
  document.getElementById('upload-list').classList.remove('show');
}

function renderUploadList() {
  const body = document.getElementById('upload-list-body');
  if (!body) return;
  body.innerHTML = '';
  document.getElementById('upload-count').textContent = uploadQueue.length;
  uploadQueue.forEach(u => {
    const item = document.createElement('div');
    item.className = 'upload-item';
    const status = u.status === 'success' ? 'success' : u.status === 'error' ? 'err' : '';
    item.innerHTML = `
      <div class="name">${escapeHtml(u.name)} ${u.chunkInfo ? `<span style="color:var(--text-muted)">[${u.chunkInfo}]</span>` : ''}</div>
      <div class="progress"><div class="bar ${status}" style="width:${u.progress}%"></div></div>
      <div class="meta">
        <span>${u.status === 'success' ? '✓ Concluído' : u.status === 'error' ? '✗ ' + (u.error || 'Falha') : u.status === 'uploading' ? 'Enviando...' : 'Pendente'}</span>
        <span>${u.speed || ''}</span>
      </div>
    `;
    body.appendChild(item);
  });
}

async function processUploadQueue() {
  for (const u of uploadQueue) {
    if (u.status !== 'pending') continue;
    u.status = 'uploading';
    renderUploadList();
    try {
      const limit = 95 * 1024 * 1024;  // 95MB
      if (u.file.size <= limit) {
        await uploadSimple(u);
      } else {
        await uploadChunked(u);
      }
      u.status = 'success';
      u.progress = 100;
    } catch (e) {
      u.status = 'error';
      u.error = e.message;
      // e.detail carries parsed server response if available
      if (e.detail) {
        showUploadError(u, e);
      } else {
        showToast(`Falha no upload: ${u.file.name} — ${e.message}`, 'error');
      }
    }
    renderUploadList();
  }
  // Refresh após uploads
  loadFiles();
  loadTree();
  // Remove completed items after 30s
  setTimeout(() => {
    for (let i = uploadQueue.length - 1; i >= 0; i--) {
      if (uploadQueue[i].status === 'success' || uploadQueue[i].status === 'error') {
        uploadQueue.splice(i, 1);
      }
    }
    renderUploadList();
    if (uploadQueue.length === 0) hideUploadList();
  }, 30000);
}

/**
 * Parse a failed XHR response into a structured error.
 * Returns: { message, status, code, serverMsg, raw }
 */
function parseXhrError(xhr, context) {
  const raw = (xhr.responseText || '').substring(0, 2000);
  let serverMsg = raw;
  let code = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.error) serverMsg = parsed.error;
    if (parsed.code) code = parsed.code;
    if (parsed.hint) serverMsg += `\n\n💡 ${parsed.hint}`;
  } catch (_) { /* not JSON, keep raw */ }
  const reason = xhr.status === 0
    ? 'Conexão perdida (possível queda de tunnel ou timeout do Cloudflare para arquivos >100MB).'
    : `HTTP ${xhr.status}`;
  return {
    message: `${context}: ${reason}`,
    status: xhr.status,
    code,
    serverMsg,
    raw
  };
}

function showUploadError(u, err) {
  const detail = err.detail || {};
  const statusTxt = detail.status ? `HTTP ${detail.status}` : 'erro';
  const codeTxt = detail.code ? `<span class="badge">${escapeHtml(detail.code)}</span>` : '';
  openModal(
    `Falha no upload — ${escapeHtml(u.file.name)}`,
    `
      <div class="form-group">
        <label>Status</label>
        <div>${escapeHtml(statusTxt)} ${codeTxt}</div>
      </div>
      <div class="form-group">
        <label>Arquivo</label>
        <div>${escapeHtml(u.file.name)} — ${formatBytes(u.file.size)}</div>
      </div>
      <div class="form-group">
        <label>Mensagem do servidor</label>
        <pre class="error-pre">${escapeHtml(detail.serverMsg || err.message || 'Sem detalhes.')}</pre>
      </div>
      ${u.chunkInfo ? `
        <div class="form-group">
          <label>Progresso de chunks</label>
          <div>${escapeHtml(u.chunkInfo)}</div>
        </div>
      ` : ''}
      <div class="hint">
        Dica: ative <b>👁 chunks</b> na toolbar para ver sessões parciais em <code>/.chunks/</code>
        e retomar manualmente se o servidor suportar.
      </div>
    `,
    `
      <button class="btn" data-act="cancel">Fechar</button>
      <button class="btn primary" data-act="retry">Tentar novamente</button>
    `
  );
  // Bind modal buttons
  const modal = document.getElementById('modal');
  const closeBtn = modal.querySelector('[data-act="cancel"]');
  const retryBtn = modal.querySelector('[data-act="retry"]');
  if (closeBtn) closeBtn.onclick = closeModal;
  if (retryBtn) retryBtn.onclick = () => {
    closeModal();
    // Reset queue item and re-process
    u.status = 'pending';
    u.progress = 0;
    u.error = null;
    u.chunkInfo = null;
    processUploadQueue();
  };
}

function uploadSimple(u) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // Path na URL pra suportar subpasta (sem token na query — POST exige Authorization header)
    const path = store.state.currentPath ? '/' + encodeURIComponent(store.state.currentPath) : '';
    xhr.open('POST', `/upload${path}`);
    const auth = authHeader();
    if (auth) xhr.setRequestHeader('Authorization', auth);
    const formData = new FormData();
    formData.append('file', u.file);
    const startTime = Date.now();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        u.progress = (e.loaded / e.total) * 100;
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? e.loaded / elapsed : 0;
        u.speed = `${formatBytes(speed)}/s`;
        renderUploadList();
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        const detail = parseXhrError(xhr, 'Upload simples');
        const e = new Error(detail.message);
        e.detail = detail;
        reject(e);
      }
    };
    xhr.onerror = () => {
      const detail = parseXhrError(xhr, 'Upload simples');
      const e = new Error(detail.message);
      e.detail = detail;
      reject(e);
    };
    xhr.send(formData);
  });
}

async function uploadChunked(u) {
  const uploadId = 'upl-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const chunkSize = 90 * 1024 * 1024;  // 90MB
  const totalChunks = Math.ceil(u.file.size / chunkSize);
  const startTime = Date.now();
  u.chunkInfo = `0/${totalChunks}`;

  // Init
  const init = await api.chunkInit(uploadId, u.file.name, u.file.size, totalChunks);
  if (!init.success) {
    const e = new Error('Init falhou: ' + JSON.stringify(init));
    e.detail = { message: 'Init falhou', serverMsg: JSON.stringify(init, null, 2), status: 0, code: 'INIT_FAILED' };
    throw e;
  }

  // Send chunks sequentially
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, u.file.size);
    const chunkBlob = u.file.slice(start, end);

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/upload/chunk`);
      const auth = authHeader();
      if (auth) xhr.setRequestHeader('Authorization', auth);
      const formData = new FormData();
      formData.append('file', chunkBlob, u.file.name);
      formData.append('uploadId', uploadId);
      formData.append('chunkIndex', i);
      formData.append('totalChunks', totalChunks);
      formData.append('fileName', u.file.name);
      formData.append('totalSize', u.file.size);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const uploadedBytes = start + e.loaded;
          u.progress = (uploadedBytes / u.file.size) * 100;
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = elapsed > 0 ? uploadedBytes / elapsed : 0;
          u.speed = `${formatBytes(speed)}/s`;
          u.chunkInfo = `${i + 1}/${totalChunks}`;
          renderUploadList();
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          const detail = parseXhrError(xhr, `Chunk ${i + 1}/${totalChunks}`);
          detail.uploadId = uploadId;
          detail.chunkIndex = i;
          const e = new Error(detail.message);
          e.detail = detail;
          reject(e);
        }
      };
      xhr.onerror = () => {
        const detail = parseXhrError(xhr, `Chunk ${i + 1}/${totalChunks}`);
        detail.uploadId = uploadId;
        detail.chunkIndex = i;
        const e = new Error(detail.message);
        e.detail = detail;
        reject(e);
      };
      xhr.send(formData);
    });
  }
  u.chunkInfo = `${totalChunks}/${totalChunks}`;
  showToast(`Upload concluído: ${u.file.name}`, 'success');
}
