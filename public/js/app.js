// ============================================================
// app.js — Bootstrap principal
// Inicializa todos os componentes e ativa polling + keyboard
// ============================================================

import { store, getInitialPath } from './state.js';
import { api } from './api.js';
import { isMobile, isDesktop, showToast } from './utils.js';
import { initSortHeaders, loadFiles, navigatePath, clearSelection } from './components/browser.js';
import { loadTree, collapseAllTree, renderTree } from './components/tree.js';
import { initDrawerTabs, clearDrawer } from './components/drawer.js';
import { initUpload, hideUploadList } from './components/upload.js';
import { initSearch } from './components/search.js';
import { initMobile, switchPanel, closeActionSheet } from './components/mobile.js';
import { closeModal, closeContextMenu, openNewFolderModal, openNewFileModal } from './components/modals.js';

// ============================================================
// Health / System info
// ============================================================
async function loadHealth() {
  try {
    const h = await api.health();
    if (!h) return;
    store.set({ health: h });
    const vEl = document.getElementById('server-version');
    if (vEl) vEl.textContent = `v${h.version}`;
    const authEnabled = h.authEnabled !== false;
    const authPill = document.getElementById('pill-auth');
    const authStatus = document.getElementById('auth-status');
    if (authPill && authStatus) {
      if (authEnabled) {
        authPill.className = 'pill ok';
        authStatus.textContent = 'Auth ON';
      } else {
        authPill.className = 'pill warn';
        authStatus.textContent = 'Auth OFF';
      }
    }
    // Tunnel type
    const host = window.location.hostname;
    let tunnel = 'Local';
    if (host.endsWith('trycloudflare.com')) tunnel = 'Cloudflare';
    else if (host.endsWith('loca.lt')) tunnel = 'Localtunnel';
    else if (host.endsWith('zrok.io')) tunnel = 'zrok';
    else if (host.endsWith('localhost.run')) tunnel = 'localhost.run';
    const connEl = document.getElementById('conn-type');
    if (connEl) connEl.textContent = tunnel;
    const tEl = document.getElementById('status-tunnel');
    if (tEl) tEl.textContent = tunnel;
  } catch (e) { console.warn('health failed', e); }
}

async function loadDisk() {
  try {
    const d = await api.df();
    if (!d) return;
    store.set({ disk: d });
    const total = d.total || 1;
    const used = d.used || 0;
    const pct = (used / total) * 100;
    const sd = document.getElementById('status-disk');
    if (sd) sd.textContent = `${d.formattedUsed} / ${d.formattedTotal}`;
    const fill = document.getElementById('disk-fill');
    if (fill) {
      fill.style.width = `${pct}%`;
      fill.className = 'fill' + (pct > 90 ? ' err' : pct > 75 ? ' warn' : '');
    }
  } catch (e) { console.warn('df failed', e); }
}

async function loadPwd() {
  try {
    const d = await api.pwd();
    if (!d) return;
    const pwd = d.pwd || d.path || '/';
    store.set({ pwd });
    const el = document.getElementById('status-pwd');
    if (el) el.textContent = pwd;
  } catch {}
}

// ============================================================
// Auto-refresh (polling 5s + Page Visibility)
// ============================================================
let pollingTimer = null;
let isVisible = true;

function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = setInterval(() => {
    if (!isVisible) return;
    // Só atualiza lista de arquivos (mais leve) e disco
    loadFiles();
  }, 5000);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

document.addEventListener('visibilitychange', () => {
  isVisible = !document.hidden;
  if (isVisible) {
    // Ao voltar a ficar visível, atualiza tudo imediatamente
    refreshAll();
    startPolling();
  } else {
    stopPolling();
  }
});

// ============================================================
// Global action dispatcher (data-action attributes)
// ============================================================
function initActionDispatcher() {
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const actions = {
      'toggle-sidebar': toggleSidebar,
      'toggle-drawer': toggleDrawer,
      'refresh': refreshAll,
      'refresh-files': () => { loadFiles(); loadTree(); },
      'upload': () => document.getElementById('upload-input').click(),
      'new-folder': openNewFolderModal,
      'new-file': openNewFileModal,
      'tree-collapse': collapseAllTree,
      'tree-refresh': loadTree,
      'clear-selection': clearSelection,
      'hide-upload-list': hideUploadList,
      'toggle-chunks': toggleChunks,
    };
    if (actions[action]) actions[action]();
  });
}

function toggleChunks() {
  const next = !store.state.showChunks;
  store.set({ showChunks: next });
  const btn = document.querySelector('[data-action="toggle-chunks"]');
  if (btn) {
    btn.classList.toggle('active', next);
    btn.textContent = next ? '👁 chunks' : '👁‍🗨 chunks';
  }
  loadFiles();
}

function toggleSidebar() {
  if (isDesktop()) {
    document.querySelector('.main').classList.toggle('collapsed-left');
  } else {
    switchPanel('tree');
  }
}

function toggleDrawer() {
  if (isDesktop()) {
    document.querySelector('.main').classList.toggle('collapsed-right');
  } else {
    switchPanel('drawer');
  }
}

// ============================================================
// Keyboard shortcuts
// ============================================================
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Skip when typing
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === 'F5') { e.preventDefault(); refreshAll(); }
    else if (e.ctrlKey && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
    else if (e.ctrlKey && e.key === 'd') { e.preventDefault(); toggleDrawer(); }
    else if (e.ctrlKey && e.key === 'u') { e.preventDefault(); document.getElementById('upload-input').click(); }
    else if (e.ctrlKey && e.key === 'n') { e.preventDefault(); openNewFolderModal(); }
    else if (e.key === 'Delete' && store.state.selectedItem) {
      e.preventDefault();
      const tr = document.querySelector('.file-table tr.selected');
      if (tr) import('./components/modals.js').then(m => m.deleteItem(store.state.selectedItem, tr.dataset.type === 'dir'));
    }
    else if (e.key === 'Escape') {
      closeModal();
      closeContextMenu();
      closeActionSheet();
      clearSelection();
    }
  });
}

// ============================================================
// Refresh all
// ============================================================
function refreshAll() {
  loadHealth();
  loadDisk();
  loadPwd();
  loadFiles();
  loadTree();
}

// ============================================================
// Bootstrap
// ============================================================
function bootstrap() {
  // Initial path from URL
  store.set({ currentPath: getInitialPath() });

  // Inicializa componentes
  initSortHeaders();
  initDrawerTabs();
  initUpload();
  initSearch();
  initActionDispatcher();
  initKeyboard();

  // Mobile inicialização
  if (!isDesktop()) {
    initMobile();
    // Painel padrão no mobile é browser
    switchPanel('browser');
  }

  // Carga inicial
  refreshAll();
  startPolling();
}

// Run on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
