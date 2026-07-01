// ============================================================
// utils.js — funções utilitárias puras (sem side effects)
// ============================================================

export function formatBytes(b) {
  if (!b || b === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(i > 1 ? 2 : 1) + ' ' + sizes[i];
}

export function formatDate(s) {
  if (!s) return '—';
  try {
    const d = new Date(s);
    if (isNaN(d)) return s;
    return d.toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch { return s; }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function escapeAttr(s) {
  return String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

export function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

export function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text)
      .then(() => showToast('Copiado: ' + text.substring(0, 40), 'success'))
      .catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast('Copiado', 'success');
  } catch {
    showToast('Falha ao copiar', 'error');
  }
  document.body.removeChild(ta);
}

export function getFileIcon(file) {
  if (file.type === 'dir') return { cls: 'folder', char: '📁' };
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext))
    return { cls: 'image', char: '🖼' };
  if (['mp4', 'avi', 'mov', 'mkv', 'webm'].includes(ext))
    return { cls: 'video', char: '🎬' };
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext))
    return { cls: 'archive', char: '🗜' };
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'html', 'css', 'json', 'xml', 'yaml', 'yml'].includes(ext))
    return { cls: 'code', char: '⌨' };
  if (['txt', 'md', 'log', 'csv', 'rtf'].includes(ext))
    return { cls: 'text', char: '📄' };
  return { cls: 'file', char: '📄' };
}

export function showToast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  const icons = { success: '✓', error: '✗', warn: '⚠', info: 'ℹ' };
  t.innerHTML = `<span class="icon">${icons[type] || 'ℹ'}</span><span>${escapeHtml(msg)}</span>`;
  c.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity 0.3s';
    setTimeout(() => t.remove(), 300);
  }, 4000);
}

export function debounce(fn, ms = 250) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

export function isMobile() {
  return window.matchMedia('(max-width: 767px)').matches ||
    window.matchMedia('(pointer: coarse)').matches;
}

export function isDesktop() {
  return window.matchMedia('(min-width: 1024px)').matches;
}
