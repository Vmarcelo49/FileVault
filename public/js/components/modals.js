// ============================================================
// components/modals.js — Modais + context menu + ações de arquivo
// ============================================================

import { store } from '../state.js';
import { api } from '../api.js';
import { escapeHtml, escapeAttr, encodePath, showToast } from '../utils.js';
import { loadFiles } from './browser.js';
import { clearSelection } from './browser.js';
import { loadTree } from './tree.js';
import { clearDrawer } from './drawer.js';

// ============================================================
// Modal primitives
// ============================================================
export function openModal(title, bodyHtml, footerHtml, sizeClass = '') {
  const modal = document.getElementById('modal');
  modal.className = 'modal' + (sizeClass ? ' ' + sizeClass : '');
  modal.innerHTML = `
    <div class="modal-header">
      <div class="title">${title}</div>
      <button class="icon-btn" data-act="close">✕</button>
    </div>
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-footer">${footerHtml || ''}</div>
  `;
  document.getElementById('modal-backdrop').classList.add('show');
  modal.querySelector('[data-act="close"]').onclick = closeModal;
}

export function closeModal() {
  document.getElementById('modal-backdrop').classList.remove('show');
}

// ============================================================
// New Folder
// ============================================================
export function openNewFolderModal() {
  const basePath = store.state.currentPath || '';
  openModal('Nova pasta', `
    <div class="form-group">
      <label>Nome da pasta</label>
      <input type="text" id="modal-folder-name" placeholder="ex: documentos" autofocus>
      <div class="hint">Será criada em: /${escapeHtml(basePath || 'root')}</div>
    </div>
  `, `
    <button class="btn" data-act="cancel">Cancelar</button>
    <button class="btn primary" data-act="submit">Criar</button>
  `);
  bindModalActions({
    cancel: closeModal,
    submit: submitNewFolder
  });
  setTimeout(() => {
    const inp = document.getElementById('modal-folder-name');
    if (inp) {
      inp.focus();
      inp.onkeydown = (e) => { if (e.key === 'Enter') submitNewFolder(); };
    }
  }, 50);
}

async function submitNewFolder() {
  const name = document.getElementById('modal-folder-name').value.trim();
  if (!name) return showToast('Nome vazio', 'warn');
  const fullPath = store.state.currentPath ? `${store.state.currentPath}/${name}` : name;
  try {
    const r = await api.mkdir(fullPath);
    if (r.ok) {
      showToast(`Pasta criada: ${fullPath}`, 'success');
      closeModal();
      loadFiles();
      loadTree();
    } else {
      showToast('Erro: ' + (await r.text), 'error');
    }
  } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

// ============================================================
// New File
// ============================================================
export function openNewFileModal() {
  const basePath = store.state.currentPath || '';
  openModal('Novo arquivo', `
    <div class="form-group">
      <label>Nome do arquivo</label>
      <input type="text" id="modal-file-name" placeholder="ex: notas.txt">
      <div class="hint">Será criado em: /${escapeHtml(basePath || 'root')}</div>
    </div>
    <div class="form-group">
      <label>Conteúdo (opcional)</label>
      <textarea id="modal-file-content" placeholder="Digite o conteúdo aqui..."></textarea>
    </div>
  `, `
    <button class="btn" data-act="cancel">Cancelar</button>
    <button class="btn primary" data-act="submit">Criar</button>
  `);
  bindModalActions({
    cancel: closeModal,
    submit: submitNewFile
  });
}

async function submitNewFile() {
  const name = document.getElementById('modal-file-name').value.trim();
  const content = document.getElementById('modal-file-content').value;
  if (!name) return showToast('Nome vazio', 'warn');
  const fullPath = store.state.currentPath ? `${store.state.currentPath}/${name}` : name;
  try {
    const r = content
      ? await api.write(fullPath, content)
      : await api.touch(fullPath);
    if (r.ok) {
      showToast(`Arquivo criado: ${fullPath}`, 'success');
      closeModal();
      loadFiles();
      loadTree();
    } else {
      showToast('Erro: ' + (await r.text), 'error');
    }
  } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

// ============================================================
// Rename / Move
// ============================================================
export function openRenameModal(path) {
  openModal('Renomear / Mover', `
    <div class="form-group">
      <label>Novo caminho</label>
      <input type="text" id="modal-rename-to" value="${escapeHtml(path)}" autofocus>
      <div class="hint">Atual: ${escapeHtml(path)}</div>
    </div>
  `, `
    <button class="btn" data-act="cancel">Cancelar</button>
    <button class="btn primary" data-act="submit">Renomear</button>
  `);
  bindModalActions({
    cancel: closeModal,
    submit: () => submitRename(path)
  });
  setTimeout(() => {
    const inp = document.getElementById('modal-rename-to');
    if (inp) {
      inp.focus(); inp.select();
      inp.onkeydown = (e) => { if (e.key === 'Enter') submitRename(path); };
    }
  }, 50);
}

async function submitRename(from) {
  const to = document.getElementById('modal-rename-to').value.trim();
  if (!to || to === from) { closeModal(); return; }
  try {
    const r = await api.mv(from, to);
    if (r.ok) {
      showToast(`Renomeado: ${from} → ${to}`, 'success');
      closeModal();
      clearSelection();
      loadFiles();
      loadTree();
    } else {
      showToast('Erro: ' + (await r.text), 'error');
    }
  } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

export function openMoveModal(path) {
  openModal('Mover', `
    <div class="form-group">
      <label>Novo caminho</label>
      <input type="text" id="modal-rename-to" value="${escapeHtml(path)}" autofocus>
      <div class="hint">Atual: ${escapeHtml(path)}</div>
    </div>
  `, `
    <button class="btn" data-act="cancel">Cancelar</button>
    <button class="btn primary" data-act="submit">Mover</button>
  `);
  bindModalActions({
    cancel: closeModal,
    submit: () => submitRename(path)
  });
  setTimeout(() => {
    const inp = document.getElementById('modal-rename-to');
    if (inp) {
      inp.focus(); inp.select();
      inp.onkeydown = (e) => { if (e.key === 'Enter') submitRename(path); };
    }
  }, 50);
}

// ============================================================
// Copy
// ============================================================
export function openCopyModal(path) {
  openModal('Copiar', `
    <div class="form-group">
      <label>Origem</label>
      <input type="text" value="${escapeHtml(path)}" readonly>
    </div>
    <div class="form-group">
      <label>Destino</label>
      <input type="text" id="modal-copy-to" value="${escapeHtml(path)}" autofocus>
      <div class="hint">Caminho completo do novo arquivo</div>
    </div>
  `, `
    <button class="btn" data-act="cancel">Cancelar</button>
    <button class="btn primary" data-act="submit">Copiar</button>
  `);
  bindModalActions({
    cancel: closeModal,
    submit: () => submitCopy(path)
  });
  setTimeout(() => {
    const inp = document.getElementById('modal-copy-to');
    if (inp) {
      inp.focus(); inp.select();
      inp.onkeydown = (e) => { if (e.key === 'Enter') submitCopy(path); };
    }
  }, 50);
}

async function submitCopy(from) {
  const to = document.getElementById('modal-copy-to').value.trim();
  if (!to || to === from) { closeModal(); return; }
  try {
    const r = await api.cp(from, to);
    if (r.ok) {
      showToast(`Copiado: ${from} → ${to}`, 'success');
      closeModal();
      loadFiles();
      loadTree();
    } else {
      showToast('Erro: ' + (await r.text), 'error');
    }
  } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

// ============================================================
// Delete
// ============================================================
export async function deleteItem(path, isDir) {
  const type = isDir ? 'pasta e todo conteúdo' : 'arquivo';
  if (!confirm(`Excluir ${type} "${path}"?\nEsta ação é irreversível.`)) return;
  try {
    const r = await api.delete(path);
    if (r.ok) {
      showToast(`Excluído: ${path}`, 'success');
      clearSelection();
      loadFiles();
      loadTree();
    } else {
      showToast('Falha: ' + (await r.text), 'error');
    }
  } catch (e) {
    showToast('Erro: ' + e.message, 'error');
  }
}

// ============================================================
// Downloads
// ============================================================
export function downloadFile(path) {
  const url = api.downloadUrl(path);
  triggerDownload(url, path.split('/').pop());
}

export function viewInline(path) {
  const url = api.inlineUrl(path);
  window.open(url, '_blank');
}

export function downloadZip(path) {
  const url = api.zipUrl(path);
  triggerDownload(url, (path.split('/').pop() || 'archive') + '.zip');
}

export function downloadTar(path) {
  const url = api.tarUrl(path);
  triggerDownload(url, (path.split('/').pop() || 'archive') + '.tar.gz');
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ============================================================
// Context Menu
// ============================================================
export function openContextMenu(e, path, type) {
  e.preventDefault();
  e.stopPropagation();
  const menu = document.getElementById('context-menu');
  const isDir = type === 'dir';

  menu.innerHTML = `
    ${isDir ? `
      <div class="item" data-act="open"><span class="icon">📁</span>Abrir</div>
      <div class="item" data-act="zip"><span class="icon">🗜</span>Baixar ZIP</div>
      <div class="item" data-act="tar"><span class="icon">📦</span>Baixar TAR.GZ</div>
    ` : `
      <div class="item" data-act="download"><span class="icon">⬇</span>Download</div>
      <div class="item" data-act="inline"><span class="icon">👁</span>Visualizar</div>
    `}
    <div class="sep"></div>
    <div class="item" data-act="rename"><span class="icon">✏</span>Renomear</div>
    <div class="item" data-act="copy"><span class="icon">📋</span>Copiar</div>
    <div class="item" data-act="move"><span class="icon">📤</span>Mover</div>
    <div class="item" data-act="copy-path"><span class="icon">🔗</span>Copiar caminho</div>
    <div class="sep"></div>
    <div class="item danger" data-act="delete"><span class="icon">🗑</span>Excluir</div>
  `;

  const actions = {
    open: () => import('./browser.js').then(m => m.navigatePath(path)),
    download: () => downloadFile(path),
    inline: () => viewInline(path),
    zip: () => downloadZip(path),
    tar: () => downloadTar(path),
    rename: () => openRenameModal(path),
    copy: () => openCopyModal(path),
    move: () => openMoveModal(path),
    'copy-path': () => import('../utils.js').then(m => m.copyText('/' + path)),
    delete: () => deleteItem(path, isDir)
  };

  menu.querySelectorAll('[data-act]').forEach(item => {
    item.onclick = () => {
      const act = item.dataset.act;
      closeContextMenu();
      if (actions[act]) actions[act]();
    };
  });

  // Position
  const x = Math.min(e.clientX, window.innerWidth - 200);
  const y = Math.min(e.clientY, window.innerHeight - 250);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.add('show');
}

export function closeContextMenu() {
  document.getElementById('context-menu').classList.remove('show');
}

// ============================================================
// Helper: bind modal action buttons
// ============================================================
function bindModalActions(actions) {
  const modal = document.getElementById('modal');
  Object.entries(actions).forEach(([act, fn]) => {
    const btn = modal.querySelector(`[data-act="${act}"]`);
    if (btn) btn.onclick = fn;
  });
}

// Backdrop click closes modal
document.addEventListener('DOMContentLoaded', () => {
  const backdrop = document.getElementById('modal-backdrop');
  if (backdrop) {
    backdrop.onclick = (e) => {
      if (e.target.id === 'modal-backdrop') closeModal();
    };
  }
  // Click outside context menu closes it
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.context-menu') && !e.target.closest('.file-table tr')) {
      closeContextMenu();
    }
  });
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.file-table tr')) closeContextMenu();
  });
});
