/* Open Stage 4 editor files from the native Workspace tree. */
(() => {
  'use strict';

  if (window.__hermesEditorExtLoaded) return;
  window.__hermesEditorExtLoaded = true;

  const PANEL_ID = 'he5cEditorPanel';
  const ROOT_ID = 'he5cEditorRoot';
  const PANEL_CLASS = 'he5c-editor-active';
  const PLUGIN_BASE = '/dashboard-plugins/hermes-editor/dist';
  const REACT_BUNDLE = '/extensions/hermes-editor/assets/vendor/react.bundle.js';
  const PREVIEW_EXTENSIONS = new Set([
    'zip', 'gz', 'tgz', 'bz2', 'xz', 'tar', '7z', 'dmg', 'exe', 'apk', 'iso',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg',
    'gif', 'webp', 'svg', 'mp3', 'wav', 'ogg', 'mp4', 'webm', 'mov',
  ]);
  const state = { loaded: false, loading: false, component: null, root: null, open: false };
  let coreOpenFile = null;

  function extensionOf(path) {
    const name = String(path || '').split('/').pop() || '';
    const dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  }
  function workspaceId(path) {
    let hash = 2166136261;
    for (let i = 0; i < path.length; i += 1) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
    return 'webui-' + (hash >>> 0).toString(36);
  }
  function workspaceLabel(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    return parts[parts.length - 1] || 'Workspace';
  }
  function authedFetch(url, opts) {
    return fetch(url, Object.assign({}, opts || {}, { credentials: 'same-origin' }));
  }
  function injectScript(src, onload, onerror) {
    const script = document.createElement('script');
    script.src = src; script.async = false; script.onload = onload;
    script.onerror = onerror || (() => {}); document.head.appendChild(script);
  }
  function installHostShims() {
    window.__HERMES_PLUGINS__ = {
      he5cAdapter: true,
      register(_name, component) { state.component = component; mountIfOpen(); },
    };
  }
  function loadPluginAssets(done) {
    if (state.loaded) return done(true);
    if (state.loading) return setTimeout(() => loadPluginAssets(done), 100);
    state.loading = true;
    if (!document.getElementById('he5c-plugin-css')) {
      const link = document.createElement('link');
      link.id = 'he5c-plugin-css'; link.rel = 'stylesheet';
      link.href = PLUGIN_BASE + '/style.css'; document.head.appendChild(link);
    }
    injectScript(REACT_BUNDLE, () => {
      const react = window.__HERMES_EDITOR_REACT__;
      if (!react || !react.React || !react.ReactDOM) { state.loading = false; return done(false); }
      installHostShims();
      window.__HERMES_PLUGIN_SDK__ = {
        sdkVersion: 'workspace-file-bridge', React: react.React,
        hooks: { useState: react.React.useState, useEffect: react.React.useEffect,
          useCallback: react.React.useCallback, useMemo: react.React.useMemo,
          useRef: react.React.useRef, useContext: react.React.useContext,
          createContext: react.React.createContext },
        authedFetch, buildWsAuthParam: null, buildWsUrl: null,
      };
      injectScript(PLUGIN_BASE + '/index.js', () => {
        state.loaded = true; state.loading = false; done(true);
      }, () => { state.loading = false; done(false); });
    }, () => { state.loading = false; done(false); });
  }
  function mountIfOpen() {
    if (!state.open || !state.component || state.root) return;
    const host = document.getElementById(ROOT_ID);
    const react = window.__HERMES_EDITOR_REACT__;
    if (!host || !react) return;
    state.root = react.ReactDOM.createRoot(host);
    state.root.render(react.React.createElement(state.component));
  }
  function buildPanel() {
    const panel = document.querySelector('.rightpanel');
    if (!panel) return null;
    let editor = document.getElementById(PANEL_ID);
    if (editor) return editor;
    editor = document.createElement('section'); editor.id = PANEL_ID;
    editor.setAttribute('aria-label', 'File editor');
    const header = document.createElement('div'); header.className = 'he5c-editor-header';
    const title = document.createElement('span'); title.id = 'he5cEditorTitle'; header.appendChild(title);
    const back = document.createElement('button'); back.type = 'button'; back.className = 'panel-icon-btn';
    back.textContent = 'x'; back.title = 'Back to files'; back.setAttribute('aria-label', 'Back to files');
    back.addEventListener('click', closeEditor); header.appendChild(back);
    const host = document.createElement('div'); host.id = ROOT_ID;
    editor.appendChild(header); editor.appendChild(host); panel.appendChild(editor);
    return editor;
  }
  function closeEditor() {
    state.open = false;
    delete state.error; delete state.errorPath;
    const panel = document.querySelector('.rightpanel');
    if (panel) panel.classList.remove(PANEL_CLASS);
  }
  function showEditor(path, browse) {
    const panel = document.querySelector('.rightpanel');
    const editor = buildPanel();
    if (!panel || !editor) return false;
    if (typeof toggleWorkspacePanel === 'function') { try { toggleWorkspacePanel(true); } catch (_) {} }
    if (document.documentElement.dataset.workspacePanel !== 'open' && typeof _setWorkspacePanelMode === 'function') {
      try { _setWorkspacePanelMode('browse'); } catch (_) {}
    }
    document.getElementById('he5cEditorTitle').textContent = String(path).split('/').pop() || 'Editor';
    state.open = true;
    editor.classList.toggle('he5c-editor-browse', !!browse);
    panel.classList.add(PANEL_CLASS);
    return true;
  }
  function navigateToFile(request, attempts) {
    if (typeof window.HermesEditorOpenFile === 'function') {
      window.HermesEditorOpenFile(request); return;
    }
    if ((attempts || 0) < 80) setTimeout(() => navigateToFile(request, (attempts || 0) + 1), 100);
    else showEditorError(String(request && request.path) || 'file', 0,
      'The Hermes Editor plugin never finished loading. Reload the page and try again.');
  }
  // Show the editor panel with a visible error instead of silently dropping to
  // the WebUI's read-only native preview. Used when the Stage 5C bridge or the
  // editor assets themselves are broken, so integration failures stay visible.
  function showEditorError(path, status, detail) {
    const panel = document.querySelector('.rightpanel');
    const editor = buildPanel();
    if (!panel || !editor) return;
    try { if (typeof toggleWorkspacePanel === 'function') toggleWorkspacePanel(true); } catch (_) {}
    document.getElementById('he5cEditorTitle').textContent = String(path).split('/').pop() || 'Editor';
    state.open = true;
    panel.classList.add(PANEL_CLASS);
    state.error = { status: Number(status) || 0, detail: String(detail || '') };
    renderEditorError();
    return true;
  }
  function renderEditorError() {
    const host = document.getElementById(ROOT_ID);
    if (!host) return;
    const err = state.error || { status: 0, detail: 'The Hermes Editor bridge is unavailable.' };
    let reason = String(err.detail || '');
    if (!reason && err.status === 503) reason = 'The editor bridge is not configured on the server.';
    else if (!reason && (err.status === 502 || err.status === 0)) reason = 'The editor bridge could not reach the editor backend.';
    host.innerHTML =
      '<div class="he5c-editor-error" role="alert">' +
        '<div class="he5c-editor-error-title">' + (err.status ? 'Editor unavailable (' + err.status + ')' : 'Editor unavailable') + '</div>' +
        '<div class="he5c-editor-error-msg"></div>' +
        '<div class="he5c-editor-error-actions">' +
          '<button type="button" class="he5c-editor-error-btn" data-he5c-retry>Retry</button>' +
          '<button type="button" class="he5c-editor-error-btn" data-he5c-close>Back to files</button>' +
        '</div>' +
      '</div>';
    const msg = host.querySelector('.he5c-editor-error-msg');
    if (msg) msg.textContent = reason;
    const retry = host.querySelector('[data-he5c-retry]');
    if (retry) retry.addEventListener('click', () => {
      const p = state.errorPath || '';
      delete state.error; delete state.errorPath;
      if (p) openStage4File(p);
    });
    const close = host.querySelector('[data-he5c-close]');
    if (close) close.addEventListener('click', closeEditor);
  }
  async function openStage4File(path) {
    const root = typeof S !== 'undefined' && S.session && S.session.workspace;
    if (!root || typeof root !== 'string' || !root.startsWith('/')) return coreOpenFile(path);
    const id = workspaceId(root);
    let response;
    try {
      response = await authedFetch('/api/plugins/hermes-editor/workspaces', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, label: workspaceLabel(root), provider: 'local', root }),
      });
    } catch (netErr) {
      showEditorError(path, 0, 'Could not reach the editor bridge (network error). ' + (netErr && netErr.message ? netErr.message : ''));
      return;
    }
    if (response.status === 502 || response.status === 503) {
      let detail = '';
      try { const b = await response.json(); detail = (b && b.detail) || ''; } catch (_) {}
      state.errorPath = path;
      showEditorError(path, response.status, detail);
      return;
    }
    if (!response.ok || !showEditor(path, false)) return coreOpenFile(path);
    loadPluginAssets((ok) => {
      if (ok) { mountIfOpen(); navigateToFile({ workspace: id, path }); }
      else { state.errorPath = path; showEditorError(path, 0, 'The Hermes Editor plugin assets failed to load.'); }
    });
  }
  function callWhenReady(name, arg, attempts) {
    if (typeof window[name] === 'function') { window[name](arg); return; }
    if ((attempts || 0) < 80) setTimeout(() => callWhenReady(name, arg, (attempts || 0) + 1), 100);
  }
  function openWorkspaceManager() {
    if (!showEditor('Add workspace', true)) return;
    loadPluginAssets((ok) => { if (ok) { mountIfOpen(); callWhenReady('HermesEditorManageWorkspaces'); } });
  }
  function openRemoteWorkspace(workspace) {
    if (!workspace || !showEditor(workspace.label || workspace.id, true)) return;
    loadPluginAssets((ok) => {
      if (ok) { mountIfOpen(); callWhenReady('HermesEditorSelectWorkspace', workspace.id); }
    });
  }
  function appendWorkspaceOptions(container) {
    if (!container || container.dataset.hermesEditorRemote === '1') return;
    container.dataset.hermesEditorRemote = '1';
    authedFetch('/api/plugins/hermes-editor/workspaces').then((response) => response.ok ? response.json() : null)
      .then((data) => {
        const workspaces = data && Array.isArray(data.workspaces) ? data.workspaces : [];
        workspaces.filter((workspace) => workspace.provider === 'ssh' && workspace.enabled !== false)
          .forEach((workspace) => {
            const row = document.createElement('div'); row.className = 'ws-opt he5c-remote-workspace';
            row.dataset.name = workspace.label || workspace.id;
            row.dataset.path = workspace.root_display || workspace.root || '';
            row.innerHTML = '<span class="ws-opt-name">' + (workspace.label || workspace.id) +
              '</span><span class="ws-opt-path">SSH ' + (workspace.host || '') + ' · ' +
              (workspace.root_display || workspace.root || '/') + '</span>';
            row.addEventListener('click', () => openRemoteWorkspace(workspace));
            container.appendChild(row);
          });
      }).catch(() => {});
  }
  function install(attempt) {
    if (coreOpenFile) return;
    if (typeof window.openFile !== 'function') {
      if ((attempt || 0) < 80) setTimeout(() => install((attempt || 0) + 1), 150);
      return;
    }
    coreOpenFile = window.openFile;
    document.addEventListener('click', (event) => {
      const row = event.target && event.target.closest && event.target.closest('#fileTree .file-item');
      if (!row || row.dataset.wsType !== 'file' || !row.dataset.wsPath) return;
      if (PREVIEW_EXTENSIONS.has(extensionOf(row.dataset.wsPath))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openStage4File(row.dataset.wsPath).catch((error) => {
        console.warn('[hermes-editor] Stage 4 tree bridge failed', error);
        coreOpenFile(row.dataset.wsPath);
      });
    }, true);
    window.openFile = async function (path, opts) {
      if (PREVIEW_EXTENSIONS.has(extensionOf(path))) return coreOpenFile(path, opts);
      try { return await openStage4File(path); } catch (error) {
        console.warn('[hermes-editor] Stage 4 file bridge failed', error);
        return coreOpenFile(path, opts);
      }
    };
    window.HermesEditorWebUIExtension = {
      version: '0.9.0', close: closeEditor, openWorkspaceManager, appendWorkspaceOptions,
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => install(), { once: true });
  else install();
})();
