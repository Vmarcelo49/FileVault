// ============================================================
// state.js — Store central com event emitter minimalista
// Padrão: subscribe(() => render()) nos componentes
// ============================================================

const TOKEN_STORAGE_KEY = 'filevault_token';

/**
 * Get the auth token with the following precedence:
 *   1. URL query param ?token=... (and save to localStorage, then strip from URL)
 *   2. localStorage
 *   3. Empty string (no auth)
 *
 * This way, after the first load with ?token=XXX, the token is persisted
 * in localStorage and the URL is cleaned — no more token leakage in
 * browser history, address bar, or shared links.
 */
export function getAuthToken() {
  // 1. Try URL first (one-shot — used when sharing an authenticated link)
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    // Persist for future visits
    try { localStorage.setItem(TOKEN_STORAGE_KEY, urlToken); } catch (e) { /* storage may be disabled */ }
    // Strip from URL — replaceState keeps history clean
    params.delete('token');
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
    window.history.replaceState({}, '', newUrl);
    return urlToken;
  }
  // 2. Fallback to localStorage
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch (e) {
    return '';
  }
}

/** Persist a token to localStorage (used by login form). */
export function setAuthToken(token) {
  try {
    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch (e) { /* storage may be disabled */ }
}

/** Remove the token from localStorage (logout). */
export function clearAuthToken() {
  try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch (e) { /* noop */ }
}

// Token is read once at module load; subsequent getAuthToken() calls re-read
// localStorage so changes propagate. Components that imported TOKEN at module
// load should call getAuthToken() instead if they need the freshest value.
const TOKEN = getAuthToken();

class Store {
  constructor() {
    this._state = {
      currentPath: '',
      selectedItem: null,
      selectedFile: null,
      files: [],
      tree: null,
      sortKey: 'name',
      sortDir: 'asc',
      activeTab: 'info',
      health: null,
      disk: null,
      pwd: '/',
      activePanel: 'browser',  // mobile: tree | browser | drawer
      sidebarCollapsed: false,
      drawerCollapsed: false,
      showChunks: false,  // toggles .chunks visibility in file list
    };
    this._listeners = new Set();
  }

  get state() {
    return { ...this._state };
  }

  set(patch) {
    const changes = {};
    let hasChange = false;
    for (const k in patch) {
      if (this._state[k] !== patch[k]) {
        this._state[k] = patch[k];
        changes[k] = patch[k];
        hasChange = true;
      }
    }
    if (hasChange) this._emit(changes);
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(changes) {
    this._listeners.forEach(fn => fn(this.state, changes));
  }
}

export const store = new Store();

// Helper pra atualizar URL com novo path (sem reload, sem token)
export function updateUrl(path) {
  const url = new URL(window.location.href);
  if (path) url.searchParams.set('path', path);
  else url.searchParams.delete('path');
  // Never re-add token to URL — it lives in localStorage now
  window.history.pushState({}, '', url.toString());
}

// Lê path inicial da URL
export function getInitialPath() {
  const params = new URLSearchParams(window.location.search);
  return params.get('path') || '';
}
