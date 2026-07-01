// ============================================================
// components/drawer.js — Painel direito com 4 abas (lazy load)
// ============================================================

import { store } from '../state.js';
import { api } from '../api.js';
import { escapeHtml, escapeAttr, encodePath, formatDate, formatBytes, getFileIcon, copyText, showToast } from '../utils.js';
import { downloadFile, viewInline, downloadZip, downloadTar } from './modals.js';

let currentLoadedPath = null;
let loadedTabs = new Set();

export function clearDrawer() {
  const titleEl = document.getElementById('drawer-title');
  const bodyEl = document.getElementById('drawer-body');
  if (titleEl) titleEl.innerHTML = '<span class="icon">📋</span><span class="text">Selecione um item</span>';
  if (bodyEl) bodyEl.innerHTML = `
    <div class="drawer-empty">
      <div class="icon">👈</div>
      <div>Clique em um arquivo ou pasta<br>para ver detalhes aqui</div>
    </div>`;
  currentLoadedPath = null;
  loadedTabs.clear();
}

export async function loadItemDetails(path, file) {
  currentLoadedPath = path;
  loadedTabs.clear();

  // Title
  const ic = getFileIcon(file);
  const titleEl = document.getElementById('drawer-title');
  if (titleEl) {
    titleEl.innerHTML = `
      <span class="icon ${ic.cls}">${ic.char}</span>
      <span class="text">${escapeHtml(file.name)}</span>
    `;
  }

  // Reset to info tab
  switchTab('info');

  // Render Info tab immediately
  renderInfoTab(path, file);
  loadedTabs.add('info');

  // Load extra info in background
  loadExtendedInfo(path, file);
}

function switchTab(tab) {
  store.set({ activeTab: tab });
  document.querySelectorAll('.drawer-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab));
  // Tab content is rendered into the same body — re-render the requested tab
  if (currentLoadedPath) {
    if (tab === 'info') {
      const file = store.state.selectedFile;
      if (file) renderInfoTab(currentLoadedPath, file);
    } else if (!loadedTabs.has(tab)) {
      // Lazy load
      if (tab === 'content') loadContentTab(currentLoadedPath);
      else if (tab === 'hashes') loadHashesTab(currentLoadedPath);
      else if (tab === 'stats') loadStatsTab(currentLoadedPath);
      loadedTabs.add(tab);
    } else {
      // Already loaded, just re-show (we re-render since we use single body)
      if (tab === 'content') loadContentTab(currentLoadedPath);
      else if (tab === 'hashes') loadHashesTab(currentLoadedPath);
      else if (tab === 'stats') loadStatsTab(currentLoadedPath);
    }
  }
}

export function initDrawerTabs() {
  document.querySelectorAll('.drawer-tab').forEach(t => {
    t.onclick = () => switchTab(t.dataset.tab);
  });
}

function renderInfoTab(path, file) {
  if (store.state.activeTab !== 'info') return;
  const body = document.getElementById('drawer-body');
  if (!body) return;

  body.innerHTML = `
    <div class="action-row">
      ${file.type === 'dir' ? `
        <button class="btn sm" data-act="zip">🗜 ZIP</button>
        <button class="btn sm" data-act="tar">📦 TAR</button>
      ` : `
        <button class="btn primary sm" data-act="download">⬇ Download</button>
        <button class="btn sm" data-act="inline">👁 Visualizar</button>
      `}
    </div>
    <div class="action-row">
      <button class="btn sm" data-act="rename">✏ Renomear</button>
      <button class="btn sm" data-act="copy">📋 Copiar</button>
      <button class="btn sm" data-act="move">📤 Mover</button>
      <button class="btn danger sm" data-act="delete">🗑 Excluir</button>
    </div>
    <div class="section">
      <div class="section-title">Propriedades</div>
      <div class="kv-grid" id="info-grid">
        <div class="key">Nome</div><div class="val">${escapeHtml(file.name)}</div>
        <div class="key">Tipo</div><div class="val">${file.type === 'dir' ? 'Diretório' : 'Arquivo'}</div>
        <div class="key">Tamanho</div><div class="val">${file.type === 'dir' ? '—' : (file.formattedSize || formatBytes(file.size))}</div>
        <div class="key">Modificado</div><div class="val">${formatDate(file.modified)}</div>
        <div class="key">Caminho</div><div class="val copyable" data-copy="/${escapeHtml(path)}" title="Clique para copiar">/${escapeHtml(path)}</div>
      </div>
      <div id="info-extra"></div>
    </div>
  `;

  // Bind action buttons
  body.querySelectorAll('[data-act]').forEach(btn => {
    btn.onclick = () => {
      const act = btn.dataset.act;
      if (act === 'download') downloadFile(path);
      else if (act === 'inline') viewInline(path);
      else if (act === 'zip') downloadZip(path);
      else if (act === 'tar') downloadTar(path);
      else if (act === 'rename') import('./modals.js').then(m => m.openRenameModal(path));
      else if (act === 'copy') import('./modals.js').then(m => m.openCopyModal(path));
      else if (act === 'move') import('./modals.js').then(m => m.openMoveModal(path));
      else if (act === 'delete') import('./modals.js').then(m => m.deleteItem(path, file.type === 'dir'));
    };
  });

  // Click to copy path
  const copyEl = body.querySelector('[data-copy]');
  if (copyEl) copyEl.onclick = () => copyText(copyEl.dataset.copy);
}

async function loadExtendedInfo(path, file) {
  const extra = document.getElementById('info-extra');
  if (!extra) return;

  // Special case: meta.json inside .chunks/<uploadId>/ — show parsed upload session
  const chunkMatch = path.match(/^\.chunks\/([^/]+)\/meta\.json$/);
  if (chunkMatch) {
    try {
      const meta = await api.head(path, 500);
      const parsed = JSON.parse(meta);
      if (store.state.activeTab === 'info' && currentLoadedPath === path) {
        const pct = parsed.totalChunks > 0
          ? ((parsed.receivedChunks?.length || 0) / parsed.totalChunks * 100).toFixed(1)
          : '0';
        const statusColor = parsed.finalized ? '#10b981' : (pct === '100' ? '#3b82f6' : '#f59e0b');
        const statusLabel = parsed.finalized ? 'Finalizado' : (pct === '100' ? 'Aguardando finalize' : 'Em andamento');
        extra.innerHTML += `
          <div class="section" style="margin-top:12px">
            <div class="section-title" style="color:${statusColor}">📦 Sessão de upload chunked</div>
            <div class="kv-grid">
              <div class="key">uploadId</div><div class="val copyable" data-copy="${escapeHtml(parsed.uploadId || '')}" title="Clique para copiar">${escapeHtml(parsed.uploadId || '—')}</div>
              <div class="key">Arquivo</div><div class="val">${escapeHtml(parsed.originalName || parsed.fileName || '—')}</div>
              <div class="key">Tamanho total</div><div class="val">${formatBytes(parsed.totalSize || 0)}</div>
              <div class="key">Chunks recebidos</div><div class="val">${parsed.receivedChunks?.length || 0} / ${parsed.totalChunks || 0}</div>
              <div class="key">Progresso</div><div class="val"><strong style="color:${statusColor}">${pct}%</strong></div>
              <div class="key">Status</div><div class="val" style="color:${statusColor}">${statusLabel}</div>
              <div class="key">Criado em</div><div class="val">${formatDate(parsed.createdAt)}</div>
              <div class="key">Atualizado em</div><div class="val">${formatDate(parsed.updatedAt)}</div>
              ${parsed.finalizedAt ? `<div class="key">Finalizado em</div><div class="val">${formatDate(parsed.finalizedAt)}</div>` : ''}
              ${parsed.targetPath ? `<div class="key">Pasta destino</div><div class="val">${escapeHtml(parsed.targetPath)}</div>` : ''}
            </div>
            <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
              ${!parsed.finalized ? `<button class="btn danger sm" data-act="cancel-upload">🗑 Cancelar e limpar</button>` : ''}
            </div>
          </div>
        `;
        const cancelBtn = extra.querySelector('[data-act="cancel-upload"]');
        if (cancelBtn) cancelBtn.onclick = async () => {
          if (!confirm(`Cancelar sessão ${parsed.uploadId}?\nOs chunks parciais serão apagados.`)) return;
          try {
            const r = await api.cancelUpload(parsed.uploadId);
            if (r.success) {
              showToast('Sessão cancelada', 'success');
              import('./browser.js').then(m => m.loadFiles());
            } else {
              showToast('Falha: ' + (r.error || 'desconhecido'), 'error');
            }
          } catch (e) { showToast('Erro: ' + e.message, 'error'); }
        };
      }
      return; // Skip default stat flow
    } catch (e) {
      // Fall through to default if parse fails
      console.warn('Could not parse chunk meta.json', e);
    }
  }

  // Stat
  try {
    const stat = await api.stat(path);
    if (stat && store.state.activeTab === 'info' && currentLoadedPath === path) {
      extra.innerHTML += `
        <div class="kv-grid">
          <div class="key">Criado</div><div class="val">${formatDate(stat.created)}</div>
          <div class="key">Size (bytes)</div><div class="val">${stat.size}</div>
        </div>
      `;
    }
  } catch {}

  if (file.type === 'dir') {
    try {
      const du = await api.du(path);
      if (du && store.state.activeTab === 'info' && currentLoadedPath === path) {
        const grid = document.getElementById('info-grid');
        if (grid) {
          grid.insertAdjacentHTML('beforeend', `
            <div class="key">Tamanho total</div><div class="val">${du.formattedSize}</div>
            <div class="key">Arquivos</div><div class="val">${du.fileCount}</div>
          `);
        }
      }
    } catch {}
  } else {
    try {
      const f = await api.fileInfo(path);
      if (f && store.state.activeTab === 'info' && currentLoadedPath === path) {
        const grid = document.getElementById('info-grid');
        if (grid) {
          grid.insertAdjacentHTML('beforeend', `
            <div class="key">MIME</div><div class="val">${f.mime}</div>
            <div class="key">Binário</div><div class="val">${f.isBinary ? 'Sim' : 'Não'}</div>
          `);
        }
      }
    } catch {}
  }
}

async function loadContentTab(path) {
  if (store.state.activeTab !== 'content') return;
  const body = document.getElementById('drawer-body');
  if (!body) return;
  body.innerHTML = '<div style="color:var(--text-muted);font-size:11px">Carregando...</div>';

  try {
    const fileInfo = await api.fileInfo(path);
    let html = '';
    const isImage = fileInfo && fileInfo.mime && fileInfo.mime.startsWith('image/');
    const isText = fileInfo && (
      fileInfo.mime.startsWith('text/') ||
      ['json', 'javascript', 'xml', 'yaml', 'csv', 'md'].includes(fileInfo.extension)
    ) && !fileInfo.isBinary;

    if (isImage) {
      const url = api.inlineUrl(path);
      html = `<div class="section">
        <div class="section-title">Preview</div>
        <div class="preview-box image"><img src="${url}" alt="preview"></div>
      </div>`;
    } else if (!fileInfo.isBinary || isText) {
      const [head, tail] = await Promise.all([
        api.head(path, 50),
        api.tail(path, 50)
      ]);
      html = `
        <div class="section">
          <div class="section-title">Head (primeiras 50 linhas)</div>
          <div class="preview-box">${escapeHtml(head) || '(vazio)'}</div>
        </div>
        <div class="section">
          <div class="section-title">Tail (últimas 50 linhas)</div>
          <div class="preview-box">${escapeHtml(tail) || '(vazio)'}</div>
        </div>
      `;
    } else {
      html = `<div class="preview-box binary">Arquivo binário (${fileInfo.mime})<br>Use o botão Download</div>`;
    }
    if (currentLoadedPath === path) body.innerHTML = html;
  } catch (e) {
    body.innerHTML = `<div class="preview-box binary">Erro: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadHashesTab(path) {
  if (store.state.activeTab !== 'hashes') return;
  const body = document.getElementById('drawer-body');
  if (!body) return;
  body.innerHTML = '<div style="color:var(--text-muted);font-size:11px">Calculando hashes...</div>';

  try {
    const [sha, md5] = await Promise.all([
      api.sha256(path),
      api.md5(path)
    ]);
    if (currentLoadedPath !== path) return;
    body.innerHTML = `
      <div class="section">
        <div class="section-title">Hashes criptográficos</div>
        <div class="hash-box">
          <span class="label">SHA256</span>
          <span class="value">${sha ? sha.hash : '(erro)'}</span>
          <button class="copy" data-copy="${sha ? sha.hash : ''}">Copy</button>
        </div>
        <div class="hash-box">
          <span class="label">MD5</span>
          <span class="value">${md5 ? md5.hash : '(erro)'}</span>
          <button class="copy" data-copy="${md5 ? md5.hash : ''}">Copy</button>
        </div>
      </div>
    `;
    body.querySelectorAll('[data-copy]').forEach(btn => {
      btn.onclick = () => copyText(btn.dataset.copy);
    });
  } catch (e) {
    body.innerHTML = `<div class="preview-box binary">Erro: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadStatsTab(path) {
  if (store.state.activeTab !== 'stats') return;
  const body = document.getElementById('drawer-body');
  if (!body) return;
  body.innerHTML = '<div style="color:var(--text-muted);font-size:11px">Carregando...</div>';

  try {
    const [wc, stat] = await Promise.all([
      api.wc(path),
      api.stat(path)
    ]);
    if (currentLoadedPath !== path) return;
    body.innerHTML = `
      <div class="section">
        <div class="section-title">Contagem (wc)</div>
        <div class="stat-grid">
          <div class="stat-card"><div class="value">${wc ? wc.lines : 0}</div><div class="label">Linhas</div></div>
          <div class="stat-card"><div class="value">${wc ? wc.words : 0}</div><div class="label">Palavras</div></div>
          <div class="stat-card"><div class="value">${wc ? wc.chars : 0}</div><div class="label">Caracteres</div></div>
          <div class="stat-card"><div class="value">${wc ? formatBytes(wc.bytes) : '0 B'}</div><div class="label">Bytes</div></div>
        </div>
      </div>
      <div class="section">
        <div class="section-title">Metadados</div>
        <div class="kv-grid">
          <div class="key">Size</div><div class="val">${stat ? stat.size : '?'} bytes</div>
          <div class="key">Created</div><div class="val">${stat ? formatDate(stat.created) : '?'}</div>
          <div class="key">Modified</div><div class="val">${stat ? formatDate(stat.modified) : '?'}</div>
          <div class="key">Type</div><div class="val">${stat ? stat.type : '?'}</div>
        </div>
      </div>
    `;
  } catch (e) {
    body.innerHTML = `<div class="preview-box binary">Erro: ${escapeHtml(e.message)}</div>`;
  }
}
