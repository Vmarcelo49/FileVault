// ============================================================
// state.js — Store central com event emitter minimalista
// Padrão: subscribe(() => render()) nos componentes
// ============================================================

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

// Helper pra ler token da URL uma vez
export function getAuthToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get('token') || '';
}

// Helper pra atualizar URL com novo path (sem reload)
export function updateUrl(path) {
  const url = new URL(window.location.href);
  if (path) url.searchParams.set('path', path);
  else url.searchParams.delete('path');
  window.history.pushState({}, '', url.toString());
}

// Lê path inicial da URL
export function getInitialPath() {
  const params = new URLSearchParams(window.location.search);
  return params.get('path') || '';
}
