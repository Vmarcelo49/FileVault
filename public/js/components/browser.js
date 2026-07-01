// ============================================================
// components/browser.js — Painel central: lista de arquivos
// ============================================================

import { store, updateUrl } from '../state.js';
import { api } from '../api.js';
import { escapeHtml, escapeAttr, encodePath, formatDate, formatBytes, getFileIcon, showToast } from '../utils.js';
import { loadTree } from './tree.js';
import { loadItemDetails, clearDrawer } from './drawer.js';
import { openContextMenu } from './modals.js';

let isLoading = false;
let lastLoadTime = 0;
let lastFileSignature = '';

export async function loadFiles() {
  if (isLoading) return;
  isLoading = true;
  renderBreadcrumbs();
  try {
    const { currentPath, showChunks } = store.state;
    const files = await api.listFiles(currentPath, { showChunks });
    lastLoadTime = Date.now();

    // Detecção de mudança pra evitar re-render desnecessário
    const sig = JSON.stringify(files.map(f => `${f.name}:${f.size}:${f.modified}`));
    if (sig !== lastFileSignature) {
      lastFileSignature = sig;
      store.set({ files });
      renderFileList();
      updateBrowserInfo();
    }
  } catch (e) {
    showToast('Erro ao carregar: ' + e.message, 'error');
  } finally {
    isLoading = false;
  }
}

export function renderBreadcrumbs() {
  const { currentPath } = store.state;
  const c = document.getElementById('breadcrumbs');
  if (!c) return;
  c.innerHTML = '';

  const root = document.createElement('span');
  root.className = 'crumb' + (!currentPath ? ' active' : '');
  root.textContent = '/';
  root.onclick = () => navigatePath('');
  c.appendChild(root);

  if (currentPath) {
    const parts = currentPath.split('/').filter(Boolean);
    let acc = '';
    parts.forEach((part, i) => {
      acc = acc ? acc + '/' + part : part;
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      c.appendChild(sep);

      const crumb = document.createElement('span');
      const isLast = i === parts.length - 1;
      crumb.className = 'crumb' + (isLast ? ' active' : '');
      crumb.textContent = part;
      if (!isLast) {
        const dest = acc;
        crumb.onclick = () => navigatePath(dest);
      }
      c.appendChild(crumb);
    });
  }
}

function updateBrowserInfo() {
  const { files } = store.state;
  const total = files.length;
  const size = files.reduce((s, f) => s + (f.size || 0), 0);
  const info = document.getElementById('browser-info');
  if (info) info.textContent = `${total} item${total !== 1 ? 's' : ''} • ${formatBytes(size)}`;
  const countEl = document.getElementById('status-count');
  if (countEl) countEl.textContent = `${total} item${total !== 1 ? 's' : ''}`;
  const sizeEl = document.getElementById('status-size');
  if (sizeEl) sizeEl.textContent = formatBytes(size);
}

export function renderFileList() {
  const { files, sortKey, sortDir, currentPath, selectedItem } = store.state;
  const tbody = document.getElementById('file-list');
  const empty = document.getElementById('empty-state');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (files.length === 0) {
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  // Parent row
  if (currentPath) {
    const tr = document.createElement('tr');
    tr.className = 'parent-row';
    tr.innerHTML = `
      <td><div class="name-cell"><span class="icon folder">📁</span><span class="label">..</span></div></td>
      <td class="size-cell">—</td>
      <td class="date-cell">—</td>
      <td class="type-cell">parent</td>
      <td></td>
    `;
    tr.onclick = () => navigateUp();
    tbody.appendChild(tr);
  }

  // Sort
  const sorted = [...files].sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    let va, vb;
    switch (sortKey) {
      case 'size': va = a.size || 0; vb = b.size || 0; break;
      case 'modified':
        va = new Date(a.modified).getTime();
        vb = new Date(b.modified).getTime();
        break;
      case 'type': va = a.type || ''; vb = b.type || ''; break;
      default: va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase();
    }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  sorted.forEach(file => {
    const itemPath = currentPath ? `${currentPath}/${file.name}` : file.name;
    const ic = getFileIcon(file);
    const tr = document.createElement('tr');
    tr.dataset.path = itemPath;
    tr.dataset.type = file.type;
    if (selectedItem === itemPath) tr.classList.add('selected');
    if (file.name === '.chunks') tr.classList.add('chunks-dir');

    const isChunkMeta = file.name === 'meta.json' && currentPath.startsWith('.chunks/');
    if (isChunkMeta) tr.classList.add('chunk-meta');

    tr.innerHTML = `
      <td><div class="name-cell">
        <span class="icon ${ic.cls}">${ic.char}</span>
        <span class="label">${escapeHtml(file.name)}</span>
      </div></td>
      <td class="size-cell">${file.type === 'dir' ? '—' : (file.formattedSize || formatBytes(file.size))}</td>
      <td class="date-cell">${formatDate(file.modified)}</td>
      <td class="type-cell">${file.type === 'dir' ? 'dir' : (file.name.split('.').pop() || 'file')}</td>
      <td class="actions-cell">
        <button class="icon-btn" title="Mais">⋯</button>
      </td>
    `;

    tr.onclick = (e) => {
      if (e.target.closest('.actions-cell')) return;
      selectItem(itemPath, file);
      if (file.type === 'dir') navigatePath(itemPath);
    };

    tr.querySelector('.actions-cell .icon-btn').onclick = (e) => {
      e.stopPropagation();
      selectItem(itemPath, file);
      openContextMenu(e, itemPath, file.type);
    };

    tr.oncontextmenu = (e) => {
      e.preventDefault();
      selectItem(itemPath, file);
      openContextMenu(e, itemPath, file.type);
    };

    tbody.appendChild(tr);
  });
}

export function navigatePath(dest) {
  store.set({ currentPath: dest, selectedItem: null, selectedFile: null });
  updateUrl(dest);
  clearDrawer();
  loadFiles();
  loadTree();
  // On mobile, switch to browser panel after navigation
  if (window.matchMedia('(max-width: 767px)').matches) {
    store.set({ activePanel: 'browser' });
    document.querySelector('.main').className = 'main active-panel-browser';
    document.querySelectorAll('.bottom-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === 'browser'));
  }
}

export function navigateUp() {
  const parts = store.state.currentPath.split('/').filter(Boolean);
  parts.pop();
  navigatePath(parts.join('/'));
}

export function selectItem(path, file) {
  store.set({ selectedItem: path, selectedFile: file });
  document.querySelectorAll('.file-table tr').forEach(tr => {
    tr.classList.toggle('selected', tr.dataset.path === path);
  });
  loadItemDetails(path, file);
  // Show drawer on mobile
  if (window.matchMedia('(max-width: 767px)').matches) {
    store.set({ activePanel: 'drawer' });
    document.querySelector('.main').className = 'main active-panel-drawer';
    document.querySelectorAll('.bottom-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === 'drawer'));
  }
}

export function clearSelection() {
  store.set({ selectedItem: null, selectedFile: null });
  document.querySelectorAll('.file-table tr.selected').forEach(tr => tr.classList.remove('selected'));
  clearDrawer();
}

// Sorting click handler
export function initSortHeaders() {
  document.querySelectorAll('.file-table th[data-sort]').forEach(th => {
    th.onclick = () => {
      const key = th.dataset.sort;
      const { sortKey, sortDir } = store.state;
      if (sortKey === key) {
        store.set({ sortDir: sortDir === 'asc' ? 'desc' : 'asc' });
      } else {
        store.set({ sortKey: key, sortDir: 'asc' });
      }
      // Update visual indicators
      document.querySelectorAll('.file-table th .sort').forEach(s => s.textContent = '');
      th.querySelector('.sort').textContent = store.state.sortDir === 'asc' ? '▲' : '▼';
      renderFileList();
    };
  });
}

// Popstate handler (browser back/forward)
window.addEventListener('popstate', () => {
  const params = new URLSearchParams(window.location.search);
  store.set({ currentPath: params.get('path') || '' });
  loadFiles();
});
