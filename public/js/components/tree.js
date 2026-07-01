// ============================================================
// components/tree.js — Sidebar com árvore de pastas E arquivos
// ============================================================

import { store } from '../state.js';
import { api } from '../api.js';
import { escapeHtml, getFileIcon, formatBytes } from '../utils.js';

let expandedPaths = new Set();

export async function loadTree() {
  try {
    const tree = await api.tree('', 5);
    store.set({ tree });
    renderTree();
  } catch (e) {
    console.warn('tree load failed', e);
  }
}

export function renderTree() {
  const { tree, currentPath, selectedItem } = store.state;
  const container = document.getElementById('tree');
  if (!container) return;
  if (!tree) {
    container.innerHTML = '<div class="tree-empty">Falha ao carregar árvore</div>';
    return;
  }
  container.innerHTML = '';
  // Auto-expand current path
  if (currentPath) {
    const parts = currentPath.split('/').filter(Boolean);
    let acc = '';
    parts.forEach(p => {
      acc = acc ? acc + '/' + p : p;
      expandedPaths.add(acc);
    });
  }
  const rootNode = createTreeNode(tree, true);
  container.appendChild(rootNode);
}

function createTreeNode(node, isRoot = false) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';

  const nodePath = (node.path || '').replace(/^\/+/, '');
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = isRoot || expandedPaths.has(nodePath);

  if (isExpanded) wrap.classList.add('expanded');

  const row = document.createElement('div');
  row.className = 'tree-row' + (isExpanded ? ' expanded' : '');
  if (nodePath === store.state.currentPath) row.classList.add('active');
  if (nodePath === store.state.selectedItem) row.classList.add('selected');

  // Chevron (só pra diretórios com children)
  const chev = document.createElement('span');
  chev.className = 'chevron';
  if (hasChildren && node.type === 'dir') {
    chev.textContent = '▶';
  } else {
    chev.textContent = '';
  }

  // Icon
  const ic = getFileIcon(node);
  const icon = document.createElement('span');
  icon.className = 'icon ' + ic.cls;
  icon.textContent = ic.char;

  // Name
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = isRoot ? 'root' : node.name;

  // Size (só arquivos)
  if (node.type !== 'dir' && node.size) {
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = formatBytes(node.size);
    row.appendChild(chev); row.appendChild(icon); row.appendChild(name); row.appendChild(size);
  } else {
    row.appendChild(chev); row.appendChild(icon); row.appendChild(name);
  }

  row.onclick = (e) => {
    e.stopPropagation();
    if (node.type === 'dir') {
      // Navega para a pasta no painel central
      import('./browser.js').then(m => m.navigatePath(nodePath));
      // Toggle expand
      if (hasChildren) {
        if (expandedPaths.has(nodePath)) {
          expandedPaths.delete(nodePath);
          wrap.classList.remove('expanded');
          row.classList.remove('expanded');
        } else {
          expandedPaths.add(nodePath);
          wrap.classList.add('expanded');
          row.classList.add('expanded');
        }
      }
    } else {
      // Arquivo: seleciona e mostra detalhes
      import('./browser.js').then(m => m.selectItem(nodePath, node));
    }
  };

  wrap.appendChild(row);

  if (hasChildren && node.type === 'dir') {
    const children = document.createElement('div');
    children.className = 'tree-children';
    // Ordena: dirs primeiro, depois arquivos alfabético
    const sorted = [...node.children].sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    sorted.forEach(c => children.appendChild(createTreeNode(c)));
    wrap.appendChild(children);
  }

  return wrap;
}

export function collapseAllTree() {
  expandedPaths.clear();
  renderTree();
}
