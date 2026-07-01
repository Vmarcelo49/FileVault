// ============================================================
// components/mobile.js — Bottom tabs + action sheet (mobile only)
// ============================================================

import { store } from '../state.js';
import { isMobile } from '../utils.js';
import { openNewFolderModal, openNewFileModal } from './modals.js';
import { initUpload } from './upload.js';
import { loadTree, collapseAllTree } from './tree.js';
import { loadFiles, clearSelection } from './browser.js';
import { clearDrawer } from './drawer.js';

export function initMobile() {
  // Bottom tabs
  document.querySelectorAll('.bottom-tab').forEach(tab => {
    tab.onclick = () => {
      if (tab.dataset.action === 'more') {
        openMoreSheet();
        return;
      }
      const t = tab.dataset.tab;
      if (!t) return;
      switchPanel(t);
    };
  });

  // Action sheet backdrop
  const backdrop = document.getElementById('action-sheet-backdrop');
  if (backdrop) {
    backdrop.onclick = closeActionSheet;
  }

  // Swipe gestures between panels
  initSwipeGestures();
}

export function switchPanel(name) {
  store.set({ activePanel: name });
  const main = document.querySelector('.main');
  if (main) {
    main.className = 'main active-panel-' + name;
  }
  document.querySelectorAll('.bottom-tab').forEach(t => {
    if (t.dataset.action) return;
    t.classList.toggle('active', t.dataset.tab === name);
  });

  // Trigger reload if needed
  if (name === 'tree') loadTree();
  else if (name === 'browser') loadFiles();
}

function openMoreSheet() {
  const sheet = document.getElementById('action-sheet');
  const backdrop = document.getElementById('action-sheet-backdrop');
  const body = document.getElementById('action-sheet-body');
  if (!sheet || !body) return;

  body.innerHTML = `
    <div class="action-sheet-item" data-act="upload"><span class="icon">⬆</span>Upload arquivo</div>
    <div class="action-sheet-item" data-act="new-folder"><span class="icon">📁</span>Nova pasta</div>
    <div class="action-sheet-item" data-act="new-file"><span class="icon">📄</span>Novo arquivo</div>
    <div class="action-sheet-sep"></div>
    <div class="action-sheet-item" data-act="refresh"><span class="icon">⟳</span>Atualizar tudo</div>
    <div class="action-sheet-item" data-act="collapse-tree"><span class="icon">⊟</span>Recolher árvore</div>
    <div class="action-sheet-sep"></div>
    <div class="action-sheet-item" data-act="close"><span class="icon">✕</span>Fechar</div>
  `;

  body.querySelectorAll('[data-act]').forEach(item => {
    item.onclick = () => {
      const act = item.dataset.act;
      closeActionSheet();
      if (act === 'upload') document.getElementById('upload-input').click();
      else if (act === 'new-folder') openNewFolderModal();
      else if (act === 'new-file') openNewFileModal();
      else if (act === 'refresh') window.location.reload();
      else if (act === 'collapse-tree') collapseAllTree();
    };
  });

  sheet.classList.add('show');
  backdrop.classList.add('show');
}

export function closeActionSheet() {
  const sheet = document.getElementById('action-sheet');
  const backdrop = document.getElementById('action-sheet-backdrop');
  if (sheet) sheet.classList.remove('show');
  if (backdrop) backdrop.classList.remove('show');
}

function initSwipeGestures() {
  let startX = 0, startY = 0, tracking = false;
  const main = document.querySelector('.main');
  if (!main) return;

  main.addEventListener('touchstart', (e) => {
    if (!isMobile()) return;
    if (e.touches.length !== 1) return;
    // Não interrompe swipe em elementos interativos
    const t = e.target;
    if (t.closest('input, textarea, button, .file-table tr, .tree-row, a')) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });

  main.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    // Só considera swipe horizontal (>50px) e mais horizontal que vertical
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;

    const { activePanel } = store.state;
    if (dx > 0) {
      // Swipe direita → painel anterior
      if (activePanel === 'drawer') switchPanel('browser');
      else if (activePanel === 'browser') switchPanel('tree');
    } else {
      // Swipe esquerda → próximo painel
      if (activePanel === 'tree') switchPanel('browser');
      else if (activePanel === 'browser') switchPanel('drawer');
    }
  }, { passive: true });
}
