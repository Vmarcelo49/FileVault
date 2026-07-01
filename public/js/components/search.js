// ============================================================
// components/search.js — Busca global com glob patterns
// ============================================================

import { api } from '../api.js';
import { escapeHtml, debounce } from '../utils.js';
import { navigatePath } from './browser.js';

export function initSearch() {
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  if (!input || !results) return;

  const debouncedSearch = debounce(async (q) => {
    if (!q) { results.classList.remove('show'); return; }
    try {
      const matches = await api.find(q);
      results.innerHTML = '';
      if (!matches || !matches.length) {
        results.innerHTML = '<div class="empty">Nenhum arquivo encontrado</div>';
      } else {
        matches.slice(0, 30).forEach(m => {
          const isDir = m.endsWith('/');
          const cleanPath = m.replace(/^\/+/, '').replace(/\/$/, '');
          const name = cleanPath.split('/').pop();
          const item = document.createElement('div');
          item.className = 'item' + (isDir ? ' dir' : '');
          item.innerHTML = `<span class="icon">${isDir ? '📁' : '📄'}</span><span>${escapeHtml(m)}</span>`;
          item.onclick = () => {
            const parent = cleanPath.split('/').slice(0, -1).join('/');
            navigatePath(parent);
            results.classList.remove('show');
            input.value = '';
          };
          results.appendChild(item);
        });
      }
      results.classList.add('show');
    } catch (e) {
      console.warn('search failed', e);
    }
  }, 250);

  input.oninput = (e) => debouncedSearch(e.target.value.trim());

  // Close results on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search')) {
      results.classList.remove('show');
    }
  });

  // Esc closes results
  input.onkeydown = (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      results.classList.remove('show');
      input.blur();
    }
  };
}
