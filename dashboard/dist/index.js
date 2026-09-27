/* Hermes Editor - Stage 4.
 *
 * Monaco stays the editor for code/text files (Stage 3 behaviour is fully
 * preserved); .md files open as a rendered WYSIWYG ProseMirror document
 * backed by the pure markdown<->JSON core in bundle.js. Storage remains
 * ordinary portable Markdown through the Stage 3 revision-safe atomic
 * write API - no TipTap/ProseMirror JSON or HTML is ever written into
 * .md files.
 *
 * React still comes only from the host SDK. All styles are scoped .he-*.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  var registry = window.__HERMES_PLUGINS__;
  if (!SDK || !registry || typeof registry.register !== "function") return;

  var h = SDK.React.createElement;
  var useState = SDK.hooks.useState;
  var useEffect = SDK.hooks.useEffect;
  var useCallback = SDK.hooks.useCallback;
  var useRef = SDK.hooks.useRef;

  var MONACO_BASE = "/dashboard-plugins/hermes-editor/dist/monaco";
  var BUNDLE_URL = "/dashboard-plugins/hermes-editor/dist/bundle.js";
  var API_BASE = "/api/plugins/hermes-editor";
  var SYNC_WS_PATH = "/api/plugins/hermes-editor/events";

  // Stage 5B protocol constants (must mirror hecore.sync).
  var SYNC_PROTOCOL = 1;
  var SYNC_RECONNECT_BASE_MS = 1000;
  var SYNC_RECONNECT_MAX_MS = 15000;
  var SYNC_FALLBACK_INTERVAL_MS = 4000;

  // ---------------------------------------------------------------------
  // Stage 5B: live synchronization client (WebSocket + bounded fallback)
  // ---------------------------------------------------------------------

  /*
   * One persistent connection per browser client. Behaviour contract:
   * - reconnect with bounded exponential backoff + jitter
   * - subscriptions are deduplicated and re-sent after reconnect
   * - a lightweight revision poll of OPEN files only runs while the
   *    socket is down (never a workspace-tree scan)
   * - clean disposal of timers/sockets on close()
   */
  function createSyncClient(opts) {
    var sock = null;
    var closedByUs = false;
    var attempts = 0;
    var reconnectTimer = null;
    var fallbackTimer = null;
    var subs = {};            // "wid\u0000path" -> {workspace,path,revision}
    var pendingHello = true;
    var clientId = opts.clientId;

    function wsUrlParam() {
      if (!SDK.buildWsAuthParam) return Promise.resolve(null);
      return SDK.buildWsAuthParam().then(function (pair) {
        return pair && pair.length === 2 ? { name: pair[0], value: pair[1] } : null;
      }).catch(function () { return null; });
    }

    function connect() {
      if (closedByUs) return;
      clearTimeout(reconnectTimer);
      wsUrlParam().then(function (authParam) {
        if (closedByUs) return;
        var url;
        if (SDK.buildWsUrl) {
          url = SDK.buildWsUrl({
            path: SYNC_WS_PATH,
            authParam: authParam ? [authParam.name, authParam.value] : undefined,
          });
        } else {
          url = (location.protocol === "https:" ? "wss://" : "ws://") +
            location.host + SYNC_WS_PATH +
            (authParam ? "?" + authParam.name + "=" + encodeURIComponent(authParam.value) : "");
        }
        try { sock = new WebSocket(url); } catch (_e) { scheduleReconnect(); return; }
        sock.onopen = function () {
          attempts = 0;
          pendingHello = true;
          stopFallbackPolling();
          send({ type: "hello", client_id: clientId });
          resendSubscriptions();
          if (opts.onConnected) opts.onConnected();
        };
        sock.onmessage = function (m) {
          var ev;
          try { ev = JSON.parse(m.data); } catch (_e2) { return; }
          if (!ev || typeof ev.type !== "string") return;
          if (ev.v !== SYNC_PROTOCOL) {
            // unknown protocol version: ask for full resync, never guess
            if (opts.onEvent) opts.onEvent({ type: "resync.required", reason: "protocol" });
            return;
          }
          if (pendingHello && ev.type !== "hello" && ev.type !== "pong") pendingHello = false;
          if (opts.onEvent) opts.onEvent(ev);
        };
        sock.onclose = function () { sock = null; scheduleReconnect(); };
        sock.onerror = function () { /* onclose follows */ };
      });
    }

    function scheduleReconnect() {
      if (closedByUs) return;
      startFallbackPolling();       // lightweight bridge while disconnected
      var delay = Math.min(SYNC_RECONNECT_MAX_MS,
        SYNC_RECONNECT_BASE_MS * Math.pow(2, Math.min(attempts, 5))) +
        Math.floor(Math.random() * 400);
      attempts += 1;
      reconnectTimer = setTimeout(connect, delay);
      if (opts.onDisconnected) opts.onDisconnected();
    }

    function send(obj) {
      if (sock && sock.readyState === 1) {
        try { sock.send(JSON.stringify(obj)); } catch (_e) {}
      }
    }
    function keyOf(wid, path) { return wid + "\u0000" + path; }

    function subscribeAll(entries) {
      // entries: [{workspace, path, revision}]; duplicates are ignored.
      var wanted = {};
      entries.forEach(function (e3) { wanted[keyOf(e3.workspace, e3.path)] = e3; });
      Object.keys(subs).forEach(function (k4) {
        if (!wanted[k4]) {
          send({ type: "unsubscribe", workspace: subs[k4].workspace, path: subs[k4].path });
          delete subs[k4];
        }
      });
      Object.keys(wanted).forEach(function (k5) {
        var e4 = wanted[k5];
        var prev = subs[k5];
        if (prev && prev.revision === e4.revision) return;
        subs[k5] = { workspace: e4.workspace, path: e4.path, revision: e4.revision };
        send({ type: "subscribe", workspace: e4.workspace, path: e4.path,
               revision: e4.revision || "" });
      });
    }

    function unsubscribe(wid, path) {
      var k6 = keyOf(wid, path);
      if (!subs[k6]) return;
      send({ type: "unsubscribe", workspace: wid, path: path });
      delete subs[k6];
    }

    function resendSubscriptions() {
      Object.keys(subs).forEach(function (k7) {
        var s2 = subs[k7];
        send({ type: "subscribe", workspace: s2.workspace, path: s2.path,
               revision: s2.revision || "" });
      });
    }

    function updateRevision(wid, path, revision) {
      var k8 = keyOf(wid, path);
      if (subs[k8]) subs[k8].revision = revision || "";
    }

    // -- polling fallback: OPEN files only -------------------------------
    function startFallbackPolling() {
      if (fallbackTimer || !opts.pollOpenFiles) return;
      fallbackTimer = setInterval(function () {
        opts.pollOpenFiles();
      }, SYNC_FALLBACK_INTERVAL_MS);
    }
    function stopFallbackPolling() {
      if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
    }

    function dispose() {
      closedByUs = true;
      clearTimeout(reconnectTimer);
      stopFallbackPolling();
      if (sock) { try { sock.close(); } catch (_e) {} sock = null; }
    }

    connect();
    return {
      subscribeAll: subscribeAll,
      unsubscribe: unsubscribe,
      updateRevision: updateRevision,
      requestResubscribe: resendSubscriptions,
      get connected() { return !!(sock && sock.readyState === 1); },
      dispose: dispose,
    };
  }

  // ---------------------------------------------------------------------
  // low-level api helpers
  // ---------------------------------------------------------------------

  function apiGet(path, query) {
    var url = API_BASE + path;
    if (query) {
      var qs = Object.keys(query)
        .filter(function (k) { return query[k] !== undefined && query[k] !== null && query[k] !== ""; })
        .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(query[k]); })
        .join("&");
      if (qs) url += "?" + qs;
    }
    return SDK.authedFetch(url).then(function (r) {
      return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
    });
  }
  function apiSend(method, path, body, query) {
    var url = API_BASE + path;
    if (query) {
      var qs = Object.keys(query)
        .filter(function (k) { return query[k] !== undefined && query[k] !== null && query[k] !== ""; })
        .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(query[k]); })
        .join("&");
      if (qs) url += "?" + qs;
    }
    return SDK.authedFetch(url, {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
    });
  }

  // ---------------------------------------------------------------------
  // lazy asset loaders
  // ---------------------------------------------------------------------

  var monacoState = "unloaded";
  var monacoWaiters = [];
  function onMonacoReady(fn) {
    if (monacoState === "ready") return fn();
    monacoWaiters.push(fn);
    loadMonacoOnce();
  }
  function monacoDone(ok) {
    monacoState = ok ? "ready" : "failed";
    monacoWaiters.splice(0).forEach(function (f2) { f2(); });
  }
  function loadMonacoOnce() {
    if (monacoState !== "unloaded") return;
    monacoState = "loading";
    function go() {
      window.require.config({ paths: { vs: MONACO_BASE + "/vs" } });
      window.require(["vs/editor/editor.main"], function () {
        window.__HERMES_EDITOR_MONACO__ = window.monaco;
        monacoDone(true);
      }, function () { monacoDone(false); });
    }
    if (window.monaco) { window.__HERMES_EDITOR_MONACO__ = window.monaco; return monacoDone(true); }
    if (!window.require || typeof window.require.config !== "function") {
      var s = document.createElement("script");
      s.src = MONACO_BASE + "/vs/loader.js";
      s.onload = go; s.onerror = function () { monacoDone(false); };
      document.head.appendChild(s);
    } else go();
  }

  var bundleState = "unloaded";
  var bundleWaiters = [];
  function onMdCoreReady(fn) {
    if (bundleState === "ready") return fn();
    bundleWaiters.push(fn);
    loadBundleOnce();
  }
  function loadBundleOnce() {
    if (bundleState !== "unloaded") return;
    bundleState = "loading";
    var s = document.createElement("script");
    s.src = BUNDLE_URL;
    s.onload = function () { bundleState = window.__HERMES_EDITOR_MD__ ? "ready" : "failed"; bundleWaiters.splice(0).forEach(function (f3) { f3(); }); };
    s.onerror = function () { bundleState = "failed"; bundleWaiters.splice(0).forEach(function (f3) { f3(); }); };
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------------
  // misc helpers
  // ---------------------------------------------------------------------

  var LANG_BY_EXT = [
    [/^dockerfile($|\.)/i, "dockerfile"],
    [/^docker-compose.*\.ya?ml$/i, "yaml"],
    [/\.py$/i, "python"],
    [/\.cpp$|\.cc$|\.cxx$|\.hpp$|\.hh$|\.hxx$/i, "cpp"],
    [/\.c$|\.h$/i, "c"],
    [/\.ya?ml$/i, "yaml"],
    [/\.json$/i, "json"],
    [/\.(sh|bash|zsh)$/i, "shell"],
  ];
  function languageFor(name) {
    for (var i = 0; i < LANG_BY_EXT.length; i++)
      if (LANG_BY_EXT[i][0].test(name)) return LANG_BY_EXT[i][1];
    return "plaintext";
  }
  function isMarkdown(name) { return /\.md$/i.test(name); }
  function stem(path) {
    var base = path.split("/").pop();
    return base.replace(/\.[^.]*$/, "");
  }

  // ---------------------------------------------------------------------
  // Stage 5A: workspace selector + management
  // ---------------------------------------------------------------------

  function WorkspaceDot(props) {
    var cls = "he-ws-dot" + (props.online === true ? " he-ws-online"
      : props.online === false ? " he-ws-offline" : " he-ws-unknown");
    return h("span", { className: cls, title: props.title || "" });
  }

  function WorkspaceOptionRow(props) {
    var w = props.ws;
    var st = props.statuses[w.id] || {};
    return h("div", {
      key: w.id,
      className: "he-ws-option" + (props.current && props.current.id === w.id ? " he-ws-option-current" : ""),
      onClick: function () { props.onPick(w); },
    },
      h(WorkspaceDot, { online: st.online, title: st.endpoint ? "via " + st.endpoint : "" }),
      h("span", { className: "he-ws-label" }, w.label),
      h("span", { className: "he-ws-host" }, w.provider === "local" ? "this Pi" : (w.host || "")),
      h("span", {
        className: "he-ws-root", title: w.root_display || "",
      }, (w.root_display || "").split("/").pop() || "/"),
      !w.enabled ? h("span", { className: "he-ws-disabled" }, "disabled") : null
    );
  }

  function WorkspaceSelect(props) {
    var open = props.open;
    return h("div", { className: "he-ws-select" },
      h("button", {
        className: "he-ws-current",
        title: props.current ? (props.current.root_display || "") : "",
        onClick: function () { props.onToggle(); },
      },
        props.current ? [
          h(WorkspaceDot, {
            key: "d",
            online: (props.statuses[props.current.id] || {}).online,
            title: ((props.statuses[props.current.id] || {}).endpoint || ""),
          }),
          h("span", { key: "l", className: "he-ws-label" }, props.current.label),
          h("span", { key: "h", className: "he-ws-host" },
            props.current.provider === "local" ? "this Pi" : (props.current.host || "")),
          h("span", { key: "e", className: "he-ws-endpoint" },
            (props.statuses[props.current.id] || {}).endpoint || ""),
        ] : "Choose workspace...",
        h("span", { key: "c", className: "he-ws-caret" }, "\u25BE")
      ),
      open ? h("div", { className: "he-ws-menu" },
        props.workspaces.map(function (w) {
          return h(WorkspaceOptionRow, {
            key: w.id, ws: w, current: props.current,
            statuses: props.statuses, onPick: props.onPick,
          });
        }),
        h("div", { className: "he-ws-menu-footer" },
          h("button", {
            className: "he-btn he-btn-small",
            onClick: props.onManage,
          }, "Manage workspaces..."),
          h("button", {
            className: "he-btn he-btn-small", title: "Refresh availability",
            onClick: props.onRefresh,
          }, "Refresh")
        )
      ) : null
    );
  }

  function ManageWorkspacesDialog(props) {
    var editing = props.editing;   // null = creating new
    var f = props.fields;
    var setF = props.setFields;
    var isRemote = f.host !== "";
    function field(labelText, key, opts) {
      opts = opts || {};
      return h("label", { className: "he-mw-field" },
        h("span", null, labelText),
        opts.select
          ? h("select", {
              className: "he-input", value: f[key],
              onChange: function (e) { setF(Object.assign({}, f, (function () { var p = {}; p[key] = e.target.value; return p; })())); },
            }, opts.select.map(function (o2) {
              return h("option", { key: o2.value, value: o2.value }, o2.label);
            }))
          : h("input", {
              className: "he-input", value: f[key], placeholder: opts.ph || "",
              onChange: function (e) { setF(Object.assign({}, f, (function () { var p = {}; p[key] = e.target.value; return p; })())); },
            })
      );
    }
    return h("div", { className: "he-modal-overlay", role: "dialog" },
      h("div", { className: "he-modal he-modal-wide" },
        h("div", { className: "he-modal-title" },
          editing ? "Edit workspace: " + editing.id : "Add workspace"),
        h("div", { className: "he-mw-body" },
          editing ? null : field("ID (unique, optional - derived from label)", "id", { ph: "my-notes" }),
          field("Label", "label", { ph: "My Notes" }),
          field("Host", "host", {
            select: [{ value: "", label: "This Pi (local)" }].concat(
              props.hosts.map(function (hh) { return { value: hh, label: hh }; })),
          }),
          isRemote ? field("Root path on host (absolute)", "root", { ph: "/mnt/storage/..." }) : null,
          h("label", { className: "he-mw-check" },
            h("input", {
              type: "checkbox", checked: !!f.enabled,
              onChange: function (e) { setF(Object.assign({}, f, { enabled: e.target.checked })); },
            }), "Enabled"),
          h("label", { className: "he-mw-check" },
            h("input", {
              type: "checkbox", checked: !!f.index_markdown,
              onChange: function (e) { setF(Object.assign({}, f, { index_markdown: e.target.checked })); },
            }), "Index Markdown (wikilinks/backlinks)")
        ),
        h("div", { className: "he-mw-list" },
          h("div", { className: "he-mw-list-title" }, "Configured workspaces"),
          props.workspaces.map(function (w) {
            return h("div", { key: w.id, className: "he-mw-row" },
              h("span", { className: "he-mw-row-label", title: w.root_display || "" },
                w.label, " ", h("span", { className: "he-ws-host" },
                  w.provider === "local" ? "(local)" : "@" + w.host)),
              w.id === "local" ? null : h("button", {
                className: "he-btn he-btn-small", onClick: function () { props.onEdit(w); },
              }, "Edit"),
              w.id === "local" ? null : h("button", {
                className: "he-btn he-btn-small he-btn-danger", onClick: function () { props.onRemove(w); },
              }, "Remove"));
          })
        ),
        props.error ? h("div", { className: "he-mw-error" }, props.error) : null,
        h("div", { className: "he-modal-actions" },
          h("button", { className: "he-btn he-btn-primary", onClick: props.onSave },
            editing ? "Save changes" : "Add workspace"),
          h("button", { className: "he-btn", onClick: props.onClose }, "Close")
        )
      ));
  }

  // ---------------------------------------------------------------------
  // modal
  // ---------------------------------------------------------------------

  function Modal(props) {
    if (!props.open || !props.spec) return null;
    var spec = props.spec;
    return h("div", { className: "he-modal-overlay", role: "dialog" },
      h("div", { className: "he-modal" },
        h("div", { className: "he-modal-title" }, spec.title),
        spec.message ? h("div", { className: "he-modal-message" }, spec.message) : null,
        spec.input !== undefined ? h("input", {
          className: "he-input",
          defaultValue: spec.input,
          autoFocus: true,
          onChange: function (e) { props.onInput(e.target.value); },
        }) : null,
        h("div", { className: "he-modal-actions" },
          (spec.actions || []).map(function (a, i) {
            return h("button", { key: i, className: "he-btn he-btn-" + (a.kind || "default"), onClick: a.onClick }, a.label);
          })
        )
      ));
  }

  // ---------------------------------------------------------------------
  // file tree (Stage 3, unchanged behaviour)
  // ---------------------------------------------------------------------

  function TreeEntry(props) {
    var entry = props.entry;
    var expanded = props.expanded.has(entry.path);
    var children = props.childrenCache[entry.path];
    var rows = [];
    rows.push(h("div", {
      key: entry.path,
      className: "he-tree-row" + (props.activePath === entry.path ? " he-tree-row-active" : ""),
      style: { paddingLeft: (8 + props.depth * 14) + "px" },
      onClick: function () { props.onActivate(entry); },
      title: entry.path,
    },
      h("span", { className: "he-tree-glyph" }, entry.type === "dir" ? (expanded ? "-" : "+") : ">"),
      h("span", { className: "he-tree-name" }, entry.name),
      entry.type === "file" && isMarkdown(entry.name) ? h("span", { className: "he-tree-size" }, "md") : null,
      entry.type === "file" && entry.size != null && entry.size > 2000000 ? h("span", { className: "he-tree-size" }, "big") : null
    ));
    if (entry.type === "dir" && expanded) {
      if (!children) {
        rows.push(h("div", { key: entry.path + "::l", className: "he-tree-loading", style: { paddingLeft: (24 + props.depth * 14) + "px" } }, "..."));
      } else {
        children.forEach(function (c) {
          rows.push(h(TreeEntry, {
            key: c.path, entry: c, depth: props.depth + 1,
            expanded: props.expanded, childrenCache: props.childrenCache,
            activePath: props.activePath, onActivate: props.onActivate,
          }));
        });
      }
    }
    return h("div", null, rows);
  }

  function FileTree(props) {
    return h("div", { className: "he-sidebar" },
      props.wsOffline ? h("div", { className: "he-ws-offline-banner" },
        "Workspace offline - saving disabled. Open tabs are preserved.") : null,
      h(WorkspaceSelect, {
        current: props.ws, workspaces: props.workspaces,
        statuses: props.wsStatuses, open: props.wsMenuOpen,
        onToggle: function () { props.setWsMenuOpen(!props.wsMenuOpen); },
        onPick: props.onPickWorkspace, onManage: props.onManage,
        onRefresh: props.onRefreshHealth,
      }),
      h("div", { className: "he-tree" },
        props.treeStatus === "error" ? h("div", { className: "he-tree-status" }, "Could not list workspace.") :
        props.treeStatus === "loading" && !props.treeEntries ? h("div", { className: "he-tree-status" }, "Listing...") :
        props.treeEntries && props.treeEntries.length === 0 ? h("div", { className: "he-tree-status" }, "(empty)") :
        props.treeEntries ? props.treeEntries.map(function (e2) {
          return h(TreeEntry, {
            key: e2.path, entry: e2, depth: 0,
            expanded: props.expanded, childrenCache: props.childrenCache,
            activePath: props.activeDir, onActivate: props.onActivate,
          });
        }) : null
      )
    );
  }

  // ---------------------------------------------------------------------
  // markdown toolbar + find bar
  // ---------------------------------------------------------------------

  function MdToolbar(props) {
    var btns = [
      ["B", "bold", "Bold (Ctrl+B)"], ["I", "italic", "Italic (Ctrl+I)"],
      ["S", "strike", "Strikethrough"], ["</>", "code", "Inline code"],
      ["H1", "h1", "Heading 1"], ["H2", "h2", "Heading 2"], ["H3", "h3", "Heading 3"],
      ["\u2022\u2261", "bullet", "Bullet list"], ["1.\u2261", "ordered", "Numbered list"],
      ["[\u2713]", "task", "Task list"], ["\u2039\u203A", "quote", "Blockquote"],
      ["\u2014", "hr", "Horizontal rule"], ["[[ ]]", "wikilink", "Insert wiki link"],
    ];
    return h("div", { className: "he-mdtoolbar" },
      btns.map(function (b) {
        return h("button", {
          key: b[1], className: "he-tbtn", title: b[2],
          onMouseDown: function (e) { e.preventDefault(); props.onCmd(b[1]); },
        }, b[0]);
      }),
      h("button", { className: "he-tbtn", title: "Link", onMouseDown: function (e) { e.preventDefault(); props.onLink(); } }, "\uD83D\uDD17".length ? "L" : "L"),
      h("span", { className: "he-tsep" }),
      h("input", {
        className: "he-find-input", placeholder: "find", value: props.findQ,
        onChange: function (e) { props.setFindQ(e.target.value); },
        onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); props.api.findNext(props.findQ); } },
      }),
      h("button", { className: "he-tbtn", title: "Find next", onMouseDown: function (e) { e.preventDefault(); props.api.findNext(props.findQ); } }, "\u21A7"),
      h("input", { className: "he-find-input", placeholder: "replace", value: props.repQ, onChange: function (e) { props.setRepQ(e.target.value); } }),
      h("button", { className: "he-tbtn", title: "Replace all", onMouseDown: function (e) { e.preventDefault(); props.onReplaceAll(); } }, "RA")
    );
  }

  // ---------------------------------------------------------------------
  // main page
  // ---------------------------------------------------------------------

  function slugify(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "").slice(0, 64) || "workspace";
  }
  function newFields() {
    return { id: "", label: "", host: "", root: "", enabled: true, index_markdown: true };
  }

  function HermesEditorPage() {
    var workspacesS = useState([]); var workspaces = workspacesS[0], setWorkspaces = workspacesS[1];
    var wsS = useState(null); var ws = wsS[0], setWs = wsS[1];
    var hostsS = useState([]); var hosts = hostsS[0], setHosts = hostsS[1];
    var wsStatusesS = useState({}); var wsStatuses = wsStatusesS[0], setWsStatuses = wsStatusesS[1];
    var wsMenuOpenS = useState(false); var wsMenuOpen = wsMenuOpenS[0], setWsMenuOpen = wsMenuOpenS[1];
    var manageOpenS = useState(false); var manageOpen = manageOpenS[0], setManageOpen = manageOpenS[1];
    var manageEditS = useState(null); var manageEdit = manageEditS[0], setManageEdit = manageEditS[1];
    var manageFieldsS = useState(function () { return newFields(); });
    var manageFields = manageFieldsS[0], setManageFields = manageFieldsS[1];
    var manageErrS = useState(""); var manageErr = manageErrS[0], setManageErr = manageErrS[1];
    var treeE = useState(null); var treeEntries = treeE[0], setTreeEntries = treeE[1];
    var treeSt = useState("loading"); var treeStatus = treeSt[0], setTreeStatus = treeSt[1];
    var expS = useState(function () { return new Set(); }); var expanded = expS[0], setExpanded = expS[1];
    var cacheRef = useRef({});
    var actDir = useState("");

    var tabsS = useState([]); var tabs = tabsS[0], setTabs = tabsS[1];
    var actP = useState(null); var activePath = actP[0], setActivePath = actP[1];
    var tick = useState(0); var bump = tick[1];
    var dlg = useState(null); var dialog = dlg[0], setDialog = dlg[1];
    var monacoLoadS = useState(monacoState); var setMonacoLoad = monacoLoadS[1];
    var findQ = useState(""); var fQ = findQ[0], setFQ = findQ[1];
    var repQ = useState(""); var rQ = repQ[0], setRQ = repQ[1];
    var idxState = useState({ status: "idle", entries: [] }); var indexData = idxState[0], setIndexData = idxState[1];
    var backlinksOpen = useState(false); var blOpen = backlinksOpen[0], setBlOpen = backlinksOpen[1];
    var dlgRef = useRef({ specInput: "" });

    // Stage 5B: live synchronization state
    var syncRef = useRef(null);
    var clientIdRef = useRef("he-web-" + Math.random().toString(36).slice(2, 10));
    var tabsRef = useRef(tabs);
    var wsStatusesRef = useRef(wsStatuses);
    tabsRef.current = tabs;
    wsStatusesRef.current = wsStatuses;
    var syncEventRef = useRef(function () {});
    var pollOpenFilesRef = useRef(function () {});

    var refs = useRef({
      editor: null, container: null,
      models: new Map(), savedVersion: new Map(), viewStates: new Map(),
      md: new Map(),            // path -> {api, container}
      mdDirtyBase: new Map(),   // path -> serialized-markdown at clean point
      diskView: null,
      diffEditor: null, diffModels: null,
      localRenames: {},         // oldPath -> newPath for locally initiated renames
      indexFetchTimer: null,
      flashTimer: null,
    });

    // ---- helpers -------------------------------------------------------

    function updateTab(path, patch) {
      setTabs(function (prev) {
        return prev.map(function (t2) { return t2.path === path ? Object.assign({}, t2, patch) : t2; });
      });
    }
    function findTab(path) { return tabs.filter(function (t2) { return t2.path === path; })[0] || null; }

    var refreshSoon = useCallback(function () {
      if (refs.current.flashTimer) return;
      refs.current.flashTimer = setTimeout(function () {
        refs.current.flashTimer = null; bump(function (n) { return n + 1; });
      }, 200);
    }, []);

    function isDirty(path) {
      var tab = findTab(path);
      if (!tab) return false;
      if (tab.kind === "md") {
        var e2 = refs.current.md.get(path);
        return e2 ? e2.api.isDirty() : false;
      }
      if (tab.kind === "monaco") {
        var m = refs.current.models.get(path);
        return m ? m.getAlternativeVersionId() !== refs.current.savedVersion.get(path) : false;
      }
      return false;
    }

    // ---- wikilink resolution / suggestions ------------------------------

    function resolveWiki(target) {
      if (!target || !indexData.entries.length) return null;
      var t = target.replace(/^\.?\//, "");
      var tLower = t.toLowerCase();
      var stemLower = stem(t).toLowerCase();
      var found = null;
      indexData.entries.forEach(function (e3) {
        if (found) return;
        var pNorm = e3.path.replace(/\.md$/i, "").toLowerCase();
        var pFull = e3.path.toLowerCase();
        if (pFull === tLower || pNorm === tLower) found = e3;
        else if (stem(e3.path).toLowerCase() === stemLower) found = found || e3;
      });
      return found;
    }

    function suggestPages(q) {
      q = (q || "").toLowerCase();
      var out = [];
      indexData.entries.forEach(function (e3) {
        var s2 = stem(e3.path);
        var hit = s2.toLowerCase().indexOf(q) >= 0 ||
          (e3.title || "").toLowerCase().indexOf(q) >= 0 ||
          (e3.aliases || []).some(function (a) { return a.toLowerCase().indexOf(q) >= 0; });
        if (!q || hit) out.push({ label: s2, sub: e3.title && e3.title !== s2 ? e3.title : e3.path });
      });
      return out.slice(0, 8);
    }
    function suggestHeadings(target) {
      var e3 = resolveWiki(target);
      return e3 ? (e3.headings || []).map(function (hh) { return hh.text; }) : [];
    }

    // ---- index -----------------------------------------------------------

    var loadIndex = useCallback(function (forceBuild) {
      if (!ws) return;
      if (!forceBuild) {
        apiGet("/index/state", { workspace: ws.id }).then(function (res) {
          if (res.ok && res.body && res.body.entries && res.body.entries.length) {
            setIndexData({ status: "ready", entries: res.body.entries });
            return apiSend("POST", "/fs/index", null, { workspace: ws.id });
          }
          setIndexData({ status: "building", entries: [] });
          return apiSend("POST", "/fs/index", null, { workspace: ws.id });
        }).then(applyBuilt).catch(function () { setIndexData({ status: "error", entries: [] }); });
      } else {
        setIndexData({ status: "building", entries: indexData.entries });
        apiSend("POST", "/fs/index", null, { workspace: ws.id }).then(applyBuilt)
          .catch(function () { setIndexData({ status: "error", entries: [] }); });
      }
      function applyBuilt(res) {
        if (!res || !res.ok || !res.body || !res.body.entries) {
          setIndexData(function (prev) { return { status: "error", entries: prev.entries }; });
          return;
        }
        var entries = res.body.entries;
        setIndexData({ status: "ready", entries: entries });
        apiSend("PUT", "/index/state", { entries: entries }, { workspace: ws.id });
        bump(function (n) { return n + 1; });
      }
    }, [ws]);

    // ---- markdown open/save/reload ----------------------------------------

    function openMdTab(entry, fileResp) {
      onMdCoreReady(function () {
        var MD = window.__HERMES_EDITOR_MD__;
        var f = fileResp.body;
        var docJSON = MD.parseMarkdown(f.content || "");
        var tab = {
          path: entry.path, name: entry.name, kind: "md",
          status: "text", revision: f.revision, size: f.size,
          maxTextBytes: f.max_text_bytes, unsupported: 0,
          workspace: ws ? ws.id : undefined,
        };
        setTabs(function (prev) { return prev.concat([tab]); });
        setActivePath(entry.path);
        refs.current.pendingMd = refs.current.pendingMd || {};
        refs.current.pendingMd[entry.path] = docJSON;
        bump(function (n) { return n + 1; });
      });
    }

    function saveMd(path, force) {
      var tab = findTab(path);
      var entry = refs.current.md.get(path);
      if (!tab || !entry) return;
      var MD = window.__HERMES_EDITOR_MD__;
      var mdText = MD.serializeMarkdown(entry.api.toJSON()).markdown;
      var rt = MD.roundTripStable(mdText);

      function doWrite() {
        apiSend("PUT", "/fs/file",
          { path: path, content: mdText, base_revision: force ? "" : tab.revision, force: !!force },
          { workspace: ws ? ws.id : undefined })
          .then(function (res) {
            if (res.ok) {
              updateTab(path, { revision: res.body.revision, conflict: null });
              if (syncRef.current) {
                syncRef.current.updateRevision(ws ? ws.id : "", path, res.body.revision);
              }
              entry.api.markClean();
              refreshSoon();
              loadIndex(false);
              return;
            }
            if (res.status === 409) {
              setDialog({
                title: "File changed on disk",
                message: path + " was modified elsewhere since you opened it" +
                  (isDirty(path) ? " and you have unsaved WYSIWYG edits." : ".") +
                  " Reload to discard your copy, Compare to inspect the disk version, or Overwrite to keep yours.",
                actions: [
                  { label: "Reload from disk", onClick: function () { setDialog(null); reloadTab(path, true); } },
                  { label: "Compare", onClick: function () { setDialog(null); openDiskView(path); } },
                  { label: "Overwrite (explicit)", kind: "danger", onClick: function () { saveMd(path, true); } },
                  { label: "Cancel", onClick: function () { setDialog(null); } },
                ],
              });
            } else {
              setDialog({
                title: "Save failed (" + res.status + ")",
                message: JSON.stringify(res.body.detail || res.body).slice(0, 400),
                actions: [{ label: "OK", onClick: function () { setDialog(null); } }],
              });
            }
          });
      }

      if (!rt.stable) {
        setDialog({
          title: "Round-trip check failed",
          message: "Serializing this document twice does not produce identical Markdown. Saving could degrade formatting. Save anyway? (Nothing is written unless you confirm.)",
          actions: [
            { label: "Save anyway (explicit)", kind: "danger", onClick: function () { setDialog(null); doWrite(); } },
            { label: "Cancel", onClick: function () { setDialog(null); } },
          ],
        });
        return;
      }
      doWrite();
    }

    function openDiskView(path) {
      apiGet("/fs/file", { path: path, workspace: ws ? ws.id : undefined }).then(function (res) {
        if (!res.ok) return;
        var name = stem(path) + " (on disk).txt";
        setTabs(function (prev) {
          var existing = prev.filter(function (t2) { return t2.diskViewFor === path; })[0];
          if (existing) { setActivePath(existing.path); return prev; }
          var vp = "__disk__/" + path;
          var tab = {
            path: vp, name: name, kind: "diskview", status: "text",
            diskViewFor: path, content: res.body.content != null ? res.body.content :
              "(binary or oversized - shown as metadata only)",
            revision: "", size: res.body.size,
            workspace: ws ? ws.id : undefined,
          };
          setActivePath(vp);
          return prev.concat([tab]);
        });
      });
    }

    function reloadTab(path, skipConfirm) {
      var r = refs.current;
      function doReload() {
        if (findTab(path) && findTab(path).kind === "md") {
          closeTabInternal(path);
          apiGet("/fs/file", { path: path, workspace: ws ? ws.id : undefined }).then(function (res) {
            if (!res.ok) return;
            openMdTab({ path: path, name: path.split("/").pop() }, res);
          });
          return;
        }
        apiGet("/fs/file", { path: path, workspace: ws ? ws.id : undefined }).then(function (res) {
          if (!res.ok) return;
          var f = res.body;
          updateTab(path, { status: f.encoding, revision: f.revision, size: f.size });
          var model = r.models.get(path);
          if (model && f.encoding === "text") {
            model.setValue(f.content);
            r.savedVersion.set(path, model.getAlternativeVersionId());
          }
          refreshSoon();
        });
      }
      if (!skipConfirm && isDirty(path)) {
        setDialog({
          title: "Unsaved changes",
          message: path + " has unsaved edits. Reload from disk and discard them?",
          actions: [
            { label: "Discard and reload", kind: "danger", onClick: function () { setDialog(null); doReload(); } },
            { label: "Cancel", onClick: function () { setDialog(null); } },
          ],
        });
        return;
      }
      doReload();
    }

    // ---- open/close ---------------------------------------------------------

    function closeTabInternal(path) {
      var r = refs.current;
      var model = r.models.get(path);
      if (model) {
        if (r.editor && r.editor.getModel() === model) r.editor.setModel(null);
        model.dispose(); r.models.delete(path); r.savedVersion.delete(path); r.viewStates.delete(path);
      }
      var mde = r.md.get(path);
      if (mde) { try { mde.api.destroy(); } catch (_e) {} r.md.delete(path); }
      setTabs(function (prev) {
        var next = prev.filter(function (t2) { return t2.path !== path; });
        if (activePath === path) setActivePath(next.length ? next[next.length - 1].path : null);
        return next;
      });
    }

    function closeTab(path) {
      var tab = findTab(path);
      if (tab && isDirty(path) && !tab.diskViewFor) {
        setDialog({
          title: "Unsaved changes",
          message: path + " has unsaved changes. Close anyway?",
          actions: [
            { label: "Close without saving", kind: "danger", onClick: function () { setDialog(null); closeTabInternal(path); } },
            { label: "Cancel", onClick: function () { setDialog(null); } },
          ],
        });
        return;
      }
      closeTabInternal(path);
    }

    function loadDir(dirPath) {
      apiGet("/fs/tree", { path: dirPath, workspace: ws ? ws.id : undefined })
        .then(function (res) {
          if (!res.ok) { setTreeStatus("error"); return; }
          cacheRef.current[dirPath] = res.body.entries;
          if (!dirPath) { setTreeEntries(res.body.entries); setTreeStatus("ok"); }
          refreshSoon();
        }).catch(function () { setTreeStatus("error"); });
    }

    function openFile(entry) {
      if (entry.type === "dir") {
        setExpanded(function (prev) {
          var n2 = new Set(prev);
          if (n2.has(entry.path)) n2.delete(entry.path); else n2.add(entry.path);
          return n2;
        });
        if (!cacheRef.current[entry.path]) loadDir(entry.path);
        actDir[1](entry.path);
        return;
      }
      actDir[1](entry.path.split("/").slice(0, -1).join("/"));
      if (tabs.some(function (t2) { return t2.path === entry.path; })) { setActivePath(entry.path); return; }
      apiGet("/fs/file", { path: entry.path, workspace: ws ? ws.id : undefined })
        .then(function (res) {
          if (!res.ok) {
            setTabs(function (prev) {
              return prev.concat([{ path: entry.path, name: entry.name, kind: "monaco", status: res.status === 404 ? "missing" : "error", revision: "", size: 0, workspace: ws ? ws.id : undefined }]);
            });
            setActivePath(entry.path); return;
          }
          var f = res.body;
          if (isMarkdown(entry.name) && f.encoding === "text") { openMdTab(entry, res); return; }
          setTabs(function (prev) {
            return prev.concat([{
              path: entry.path, name: entry.name, kind: "monaco",
              status: f.encoding, revision: f.revision, size: f.size,
              maxTextBytes: f.max_text_bytes,
              workspace: ws ? ws.id : undefined,
            }]);
          });
          setActivePath(entry.path);
        });
    }

    function openWikiTarget(attrs) {
      var e3 = resolveWiki(attrs.target);
      if (e3) { openFile({ type: "file", path: e3.path, name: e3.path.split("/").pop() }); return; }
      // broken link -> offer to create the page
      dlgRef.current.specInput = attrs.target + ".md";
      setDialog({
        title: "Broken wiki link",
        message: 'No page "' + attrs.target + '" exists. Create it?',
        input: attrs.target + ".md",
        actions: [
          {
            label: "Create", onClick: function () {
              var p2 = (dlgRef.current.specInput || "").trim() || (attrs.target + ".md");
              setDialog(null);
              createPage(p2, attrs.target);
            },
          },
          { label: "Cancel", onClick: function () { setDialog(null); } },
        ],
      });
    }

    function createPage(relName, title) {
      var content = "# " + title + "\n\n";
      apiSend("PUT", "/fs/file", { path: relName, content: content, base_revision: "" }, { workspace: ws ? ws.id : undefined })
        .then(function (res) {
          if (!res.ok) {
            setDialog({ title: "Could not create page", message: JSON.stringify(res.body).slice(0, 300), actions: [{ label: "OK", onClick: function () { setDialog(null); } }] });
            return;
          }
          loadIndex(true);
          openFile({ type: "file", path: relName, name: relName.split("/").pop() });
        });
    }

    // ---- rename + referrer update ---------------------------------------------

    function renameCurrent() {
      var tab = findTab(activePath);
      if (!tab || !isMarkdown(tab.name)) return;
      var oldPath = tab.path;
      dlgRef.current.specInput = oldPath;
      setDialog({
        title: "Rename page",
        message: "New path relative to workspace root. Referring pages will be offered a link update.",
        input: oldPath,
        actions: [
          {
            label: "Rename", onClick: function () {
              var newPath = (dlgRef.current.specInput || "").trim() || oldPath;
              setDialog(null);
              doRename(oldPath, newPath);
            },
          },
          { label: "Cancel", onClick: function () { setDialog(null); } },
        ],
      });
    }
    function doRename(fromPath, toPath) {
      refs.current.localRenames[fromPath] = toPath;  // confident identification
      apiSend("POST", "/fs/move", { from: fromPath, to: toPath }, { workspace: ws ? ws.id : undefined })
        .then(function (res) {
          if (!res.ok) {
            delete refs.current.localRenames[fromPath];
            setDialog({ title: "Rename failed (" + res.status + ")", message: JSON.stringify(res.body).slice(0, 300), actions: [{ label: "OK", onClick: function () { setDialog(null); } }] });
            return;
          }
          var referrers = computeBacklinks(fromPath).map(function (b2) { return b2.path; });
          if (!referrers.length) { afterRename([]); return; }
          updateReferrers(referrers, stem(fromPath), stem(toPath), []);
        });

      function afterRename(updatedList) {
        loadIndex(true);
        setTabs(function (prev) {
          var renamed = prev.map(function (t2) {
            if (t2.diskViewFor === fromPath) return Object.assign({}, t2, { diskViewFor: toPath });
            if (t2.path !== fromPath) return t2;
            var e3 = refs.current.md.get(fromPath);
            if (e3) { refs.current.md.delete(fromPath); refs.current.md.set(toPath, e3); }
            return Object.assign({}, t2, { path: toPath, name: toPath.split("/").pop() });
          });
          if (activePath === fromPath) setActivePath(toPath);
          return renamed;
        });
        if (updatedList.length) {
          setDialog({
            title: "Renamed",
            message: "Links updated in:\n" + updatedList.join("\n"),
            actions: [{ label: "OK", onClick: function () { setDialog(null); } }],
          });
        }
      }

      function updateReferrers(remaining, oldStem, newStem, done) {
        if (!remaining.length) { afterRename(done); return; }
        var rp = remaining[0];
        apiGet("/fs/file", { path: rp, workspace: ws ? ws.id : undefined }).then(function (res) {
          if (!res.ok) { updateReferrers(remaining.slice(1), oldStem, newStem, done); return; }
          var content = res.body.content != null ? res.body.content : "";
          var rx = new RegExp("\\[\\[(" + oldStem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")([#\\]|])", "gi");
          var updated = content.replace(rx, "[[" + newStem + "$2");
          if (updated === content) { done.push(rp + " (no change)"); updateReferrers(remaining.slice(1), oldStem, newStem, done); return; }
          apiSend("PUT", "/fs/file",
            { path: rp, content: updated, base_revision: res.body.revision },
            { workspace: ws ? ws.id : undefined })
            .then(function (wres) {
              if (wres.status === 409) {
                done.push(rp + " (CONFLICT - not updated)");
                setDialog(null);
              } else if (!wres.ok) {
                done.push(rp + " (failed)");
              } else {
                done.push(rp);
              }
              updateReferrers(remaining.slice(1), oldStem, newStem, done);
            });
        });
      }
    }

    function computeBacklinks(forPath) {
      var targetStem = stem(forPath).toLowerCase();
      var out = [];
      indexData.entries.forEach(function (e3) {
        if (e3.path === forPath) return;
        var links = false;
        (e3.outgoing || []).forEach(function (t2) {
          var r2 = resolveWiki(t2);
          if (r2 && r2.path === forPath) links = true;
          else if (t2.toLowerCase() === targetStem) links = true;
        });
        if (links) out.push(e3);
      });
      return out;
    }

    // ---- Stage 5B: live synchronization handlers -------------------------

    function isViewTab(t2) { return !!t2.diskViewFor || t2.kind === "diffview"; }

    function findTabWs(wid, path) {
      return tabsRef.current.filter(function (t2) {
        return t2.workspace === wid && t2.path === path && !isViewTab(t2);
      })[0] || null;
    }

    function fetchIndexSoon() {
      if (refs.current.indexFetchTimer) return;
      refs.current.indexFetchTimer = setTimeout(function () {
        refs.current.indexFetchTimer = null;
        apiGet("/index/state", { workspace: ws ? ws.id : undefined })
          .then(function (res) {
            if (!res.ok || !res.body || !Array.isArray(res.body.entries)) return;
            setIndexData({ status: "ready", entries: res.body.entries });
          });
      }, 600);
    }

    function enterConflict(tab, ev) {
      updateTab(tab.path, {
        conflict: {
          diskRevision: (ev && ev.revision) || "",
          since: Date.now(),
        },
      });
      refreshSoon();
    }

    function clearConflict(path) { updateTab(path, { conflict: null }); }

    // Clean tab: fetch latest, update editor + base revision. Never runs
    // for dirty tabs (those go through the explicit conflict flow).
    function refreshTabFromDisk(tab, ev) {
      if (!tab.workspace) return;
      apiGet("/fs/file", { path: tab.path, workspace: tab.workspace })
        .then(function (res) {
          if (!res.ok) {
            if (res.status === 404) markRemoteDeleted(tab);
            return;
          }
          var cur = findTabWs(tab.workspace, tab.path);
          if (!cur) return;
          if (isDirty(cur.path)) { enterConflict(cur, ev); return; }
          var f = res.body;
          if (f.revision && cur.revision === f.revision) return;
          if (tab.kind === "md") {
            var e5 = refs.current.md.get(tab.path);
            var MD = window.__HERMES_EDITOR_MD__;
            if (e5 && MD && f.encoding === "text") {
              // reparse through the Stage 4 WYSIWYG pipeline - never raw
              try { e5.api.setContent(MD.parseMarkdown(f.content || "")); }
              catch (_e) {}
            } else if (!e5) {
              // editor not mounted yet: stash for the mount effect
              refs.current.pendingMd = refs.current.pendingMd || {};
              if (MD && f.encoding === "text") {
                refs.current.pendingMd[tab.path] = MD.parseMarkdown(f.content || "");
              }
            }
          } else {
            var model = refs.current.models.get(tab.path);
            if (model && f.encoding === "text") {
              var r9 = refs.current;
              var vs = null;
              if (r9.editor && r9.editor.getModel() === model) {
                vs = r9.editor.saveViewState();
              }
              model.setValue(f.content == null ? "" : f.content);
              r9.savedVersion.set(tab.path, model.getAlternativeVersionId());
              if (vs && r9.editor && r9.editor.getModel() === model) {
                r9.editor.restoreViewState(vs);
              }
            }
          }
          updateTab(tab.path, { revision: f.revision, size: f.size });
          if (syncRef.current) {
            syncRef.current.updateRevision(tab.workspace, tab.path, f.revision);
          }
          if (isMarkdown(tab.name)) fetchIndexSoon();
        }).catch(function () {});
    }

    function markRemoteDeleted(tab) {
      updateTab(tab.path, { status: "deleted", deleted: true, conflict: null });
      if (syncRef.current) syncRef.current.unsubscribe(tab.workspace, tab.path);
      refreshSoon();
    }

    function onRemoteDelete(ev) {
      var tab = findTabWs(ev.workspace, ev.path);
      if (tab) markRemoteDeleted(tab);   // never silently recreate
      else refreshSoon();                 // tree may need a nudge
    }

    function onRemoteRename(ev) {
      var localNew = refs.current.localRenames[ev.old_path];
      if (localNew === ev.path) {
        // confidently identified as our own rename; adopt silently
        delete refs.current.localRenames[ev.old_path];
        setTabs(function (prev) {
          return prev.map(function (t2) {
            if (t2.workspace === ev.workspace && t2.path === ev.old_path) {
              if (syncRef.current) {
                syncRef.current.unsubscribe(ev.workspace, ev.old_path);
              }
              return Object.assign({}, t2, { path: ev.path,
                name: ev.path.split("/").pop() });
            }
            return t2;
          });
        });
        fetchIndexSoon();
        return;
      }
      // not confidently identified: require explicit user action instead
      // of guessing (spec: issue resync rather than guessing)
      var tab = findTabWs(ev.workspace, ev.old_path);
      if (tab) {
        updateTab(tab.path, { resyncRequired: true });
        if (syncRef.current) syncRef.current.unsubscribe(ev.workspace, ev.old_path);
      }
      resyncWorkspaceSoon(ev.workspace);
    }

    function resyncWorkspace(wid) {
      var openTabs = tabsRef.current.filter(function (t2) {
        return t2.workspace === wid && !isViewTab(t2) && t2.status !== "deleted";
      });
      if (!openTabs.length) return;
      apiGet("/fs/revisions", {
        paths: openTabs.map(function (t2) { return t2.path; }).join(","),
        workspace: wid,
      }).then(function (res) {
        if (!res.ok || !res.body || !Array.isArray(res.body.stats)) return;
        res.body.stats.forEach(function (st) {
          var tab = openTabs.filter(function (t3) { return t3.path === st.path; })[0];
          if (!tab) return;
          if (!st.exists) { markRemoteDeleted(tab); return; }
          if (tab.revision && st.revision && st.revision !== tab.revision) {
            if (isDirty(tab.path)) enterConflict(tab, { revision: st.revision });
            else refreshTabFromDisk(tab, { revision: st.revision });
          } else if (tab.resyncRequired) {
            updateTab(tab.path, { resyncRequired: false });
          }
        });
      }).catch(function () {});
    }
    var resyncTimers = useRef({});
    function resyncWorkspaceSoon(wid) {
      if (!wid) return;
      clearTimeout(resyncTimers.current[wid]);
      resyncTimers.current[wid] = setTimeout(function () {
        delete resyncTimers.current[wid];
        resyncWorkspace(wid);
      }, 700);
    }

    function pollOpenFilesRevisions() {
      // lightweight fallback used ONLY while the WebSocket is down:
      // revisions of OPEN files, never a tree scan.
      var byWid = {};
      tabsRef.current.forEach(function (t2) {
        if (isViewTab(t2) || !t2.workspace || t2.status === "deleted") return;
        (byWid[t2.workspace] = byWid[t2.workspace] || []).push(t2.path);
      });
      Object.keys(byWid).forEach(function (wid) {
        if ((wsStatusesRef.current[wid] || {}).online === false) return;
        apiGet("/fs/revisions", {
          paths: byWid[wid].slice(0, 64).join(","), workspace: wid,
        }).then(function (res) {
          if (!res.ok || !Array.isArray(res.body.stats)) return;
          res.body.stats.forEach(function (st) {
            var tab = findTabWs(wid, st.path);
            if (!tab) return;
            if (!st.exists) { markRemoteDeleted(tab); return; }
            if (tab.revision && st.revision && st.revision !== tab.revision) {
              if (isDirty(tab.path)) enterConflict(tab, { revision: st.revision });
              else refreshTabFromDisk(tab, { revision: st.revision });
            }
          });
        }).catch(function () {});
      });
    }
    pollOpenFilesRef.current = pollOpenFilesRevisions;

    function handleSyncEvent(ev) {
      switch (ev.type) {
        case "file.modified":
        case "file.created": {
          var tab = findTabWs(ev.workspace, ev.path);
          if (!tab || isViewTab(tab)) break;
          if (ev.revision && tab.revision === ev.revision) break; // own save echo
          if (isDirty(tab.path)) enterConflict(tab, ev);
          else refreshTabFromDisk(tab, ev);
          break;
        }
        case "file.deleted": onRemoteDelete(ev); break;
        case "file.renamed": onRemoteRename(ev); break;
        case "git.changed":
        case "resync.required":
          resyncWorkspaceSoon(ev.workspace || (ws ? ws.id : null));
          break;
        case "workspace.offline":
          setWsStatuses(function (prev) {
            var next = Object.assign({}, prev);
            next[ev.workspace] = Object.assign({}, prev[ev.workspace] || {},
              { online: false, endpoint: "" });
            return next;
          });
          refreshHealth();
          break;
        case "workspace.online":
          setWsStatuses(function (prev) {
            var next = Object.assign({}, prev);
            next[ev.workspace] = Object.assign({}, prev[ev.workspace] || {},
              { online: true, endpoint: ev.endpoint || "" });
            return next;
          });
          // revalidate before allowing blind save again
          resyncWorkspaceSoon(ev.workspace);
          refreshHealth();
          break;
        case "endpoint.changed":
          setWsStatuses(function (prev) {
            var next = Object.assign({}, prev);
            next[ev.workspace] = Object.assign({}, prev[ev.workspace] || {},
              { online: true, endpoint: ev.endpoint || "" });
            return next;
          });
          resyncWorkspaceSoon(ev.workspace);
          break;
        default:
          break;
      }
    }
    syncEventRef.current = handleSyncEvent;

    useEffect(function () {
      var client = createSyncClient({
        clientId: clientIdRef.current,
        onEvent: function (ev) { syncEventRef.current(ev); },
        onConnected: function () {},
        onDisconnected: function () {},
        pollOpenFiles: function () { pollOpenFilesRef.current(); },
      });
      syncRef.current = client;
      return function () { client.dispose(); syncRef.current = null; };
    }, []);

    // keep subscriptions in step with open tabs
    useEffect(function () {
      if (!syncRef.current) return;
      var entries = tabs
        .filter(function (t2) { return !isViewTab(t2) && t2.workspace && t2.status !== "deleted"; })
        .map(function (t2) {
          return { workspace: t2.workspace, path: t2.path, revision: t2.revision };
        });
      syncRef.current.subscribeAll(entries);
    }, [tabs]);

    // ---- monaco mount / md mount effects --------------------------------------

    function applyWorkspaces(list) {
      setWorkspaces(list);
      var st = {};
      list.forEach(function (w) { st[w.id] = { online: w.online, endpoint: w.endpoint }; });
      setWsStatuses(st);
      return st;
    }

    var refreshHealth = useCallback(function () {
      return apiGet("/workspaces").then(function (res) {
        if (!res.ok) return;
        var list = res.body.workspaces || [];
        setWorkspaces(function (prev) {
          // keep current selection object fresh
          return list;
        });
        var st = {};
        list.forEach(function (w2) { st[w2.id] = { online: w2.online, endpoint: w2.endpoint }; });
        setWsStatuses(st);
        setWs(function (cur) {
          if (!cur) return cur;
          return list.filter(function (w2) { return w2.id === cur.id; })[0] || cur;
        });
      });
    }, []);

    useEffect(function () {
      apiGet("/hosts").then(function (res) {
        if (res.ok) setHosts(res.body.hosts || []);
      });
      apiGet("/workspaces").then(function (res) {
        if (!res.ok) return;
        var list = res.body.workspaces || [];
        applyWorkspaces(list);
        if (list.length) {
          var pick = list.filter(function (w2) { return w2.id === "local" && w2.online; })[0]
            || list.filter(function (w2) { return w2.online; })[0] || list[0];
          setWs(pick);
        }
      });
      onMonacoReady(function () { setMonacoLoad(monacoState); });
      var iv = setInterval(function () { refreshHealth(); }, 20000);
      return function () { clearInterval(iv); };
    }, []);

    useEffect(function () {
      if (!ws) return;
      cacheRef.current = {};
      setTreeStatus("loading"); setTreeEntries(null);
      loadDir("");
      setIndexData({ status: "idle", entries: [] });
      loadIndex(false);
      refreshHealth();
    }, [ws ? ws.id : null]);

    useEffect(function () {
      if (monacoState !== "ready") return;
      var r = refs.current;
      if (r.editor || !r.container) return;
      var monaco = window.__HERMES_EDITOR_MONACO__;
      r.editor = monaco.editor.create(r.container, { value: "", language: "plaintext", automaticLayout: false });
      r.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () { saveActiveRef.current(); });
      var ro = new ResizeObserver(function () { r.editor.layout(); });
      ro.observe(r.container);
      return function () { ro.disconnect(); };
    });

    // mount/switch the WYSIWYG editor for the active md tab
    useEffect(function () {
      var r = refs.current;
      var tab = findTab(activePath);
      if (!tab || tab.kind !== "md") return;
      if (r.md.has(activePath)) {
        // re-focus existing instance; PM view persists per path
        try { r.md.get(activePath).api.focus(); } catch (_e) {}
        refreshSoon();
        return;
      }
      var host = document.getElementById("he-md-host");
      if (!host || !window.__HERMES_EDITOR_UI__ || monacoState !== "ready") return;
      var docJSON = r.pendingMd && r.pendingMd[activePath];
      if (!docJSON) return;
      delete r.pendingMd[activePath];
      var UI = window.__HERMES_EDITOR_UI__;
      var api = UI.createMdEditor(host, {
        docJSON: docJSON,
        resolveWiki: function (t2) { return resolveWiki(t2); },
        openWiki: openWikiTarget,
        openExternal: function (href) { window.open(href, "_blank", "noopener"); },
        suggestPages: suggestPages,
        suggestHeadings: suggestHeadings,
      });
      r.md.set(activePath, { api: api, host: host });
      bump(function (n) { return n + 1; });
      // eslint-disable-next-line
    }, [activePath, tabs.length, monacoState]);

    // keep only the active md editor mounted in the DOM
    useEffect(function () {
      var r = refs.current;
      var host = document.getElementById("he-md-host");
      if (host) {
        Object.keys(host.childNodes).length; // noop to appease linters
        while (host.firstChild && !(r.md.get(activePath) && r.md.get(activePath).host === host)) {
          // detach non-active editors' views into hidden storage is complex;
          // instead we keep one live view per open md tab but only show active
          break;
        }
      }
      r.md.forEach(function (entry2, p) {
        if (p === activePath && entry2.viewEl && entry2.viewEl.parentNode !== host) {
          host.appendChild(entry2.viewEl);
        }
      });
    });

    function ensureVisible() {
      var r = refs.current;
      if (!r.editor) return;
      var tab = findTab(activePath);
      var showMonaco = tab && tab.kind !== "md";
      if (showMonaco && tab) {
        r.editor.updateOptions({ readOnly: tab.kind === "diskview" });
        if (tab.kind === "monaco" && tab.status === "text") {
          var model = r.models.get(activePath);
          if (!model && tab.content != null) {
            var monaco = window.__HERMES_EDITOR_MONACO__;
            model = monaco.editor.createModel(tab.content, languageFor(tab.name),
              monaco.Uri.parse("hermes-editor://" + encodeURIComponent(ws ? ws.id : "") + "/" + tab.path));
            model.onDidChangeContent(function () { refreshSoon(); });
            r.models.set(activePath, model);
            r.savedVersion.set(activePath, model.getAlternativeVersionId());
          }
          if (model && r.editor.getModel() !== model) {
            if (r.editor.getModel()) r.viewStates.set(String(r.editor.getModel().id), r.editor.saveViewState());
            r.editor.setModel(model);
            var vs = r.viewStates.get(String(model.id));
            if (vs) r.editor.restoreViewState(vs);
          }
        } else {
          if (r.editor.getModel()) r.editor.setModel(null);
        }
      }
    }
    useEffect(function () { ensureVisible(); }, [activePath, tabs]);

    var saveActiveRef = useRef(function () {});
    saveActiveRef.current = saveActive;

    function saveActive() {
      var tab = findTab(activePath);
      if (!tab || tab.diskViewFor || tab.kind === "diffview") return;
      // remote deletion: never recreate by saving
      if (tab.status === "deleted" || tab.deleted) {
        setDialog({
          title: "File deleted remotely",
          message: activePath + " was deleted on the host while it was open. Saving is blocked so the file is not silently recreated.",
          actions: [{ label: "OK", onClick: function () { setDialog(null); } }],
        });
        return;
      }
      if ((wsStatuses[ws ? ws.id : ""] || {}).online === false ||
          (tab.workspace && (wsStatuses[tab.workspace] || {}).online === false)) {
        setDialog({
          title: "Workspace offline",
          message: "The host for this workspace is unreachable. Your edits are kept in the open tabs; saving is disabled until the connection returns.",
          actions: [{ label: "OK", onClick: function () { setDialog(null); } }],
        });
        return;
      }
      // known conflict: route Ctrl+S into explicit resolution, never a
      // blind CAS attempt that would surprise anyone
      if (tab.conflict) {
        setDialog({
          title: "Conflict needs resolution",
          message: activePath + " changed on disk while you had unsaved edits. Compare both versions, reload from disk, or overwrite explicitly.",
          actions: [
            { label: "Compare", onClick: function () { setDialog(null); openCompare(tab); } },
            { label: "Reload disk version", onClick: function () { setDialog(null); resolveTakeDisk(tab.path); } },
            { label: "Overwrite mine (explicit)", kind: "danger", onClick: function () { setDialog(null); resolveOverwrite(tab.path); } },
            { label: "Cancel", onClick: function () { setDialog(null); } },
          ],
        });
        return;
      }
      if (tab.kind === "md") saveMd(activePath, false);
    }

    function resolveTakeDisk(path) {
      clearConflict(path);
      reloadTab(path, true);
    }
    function resolveOverwrite(path) {
      var tab = findTab(path);
      if (!tab) return;
      setDialog({
        title: "Overwrite disk version?",
        message: "This permanently replaces the file on the host with YOUR version. The disk changes will be lost.",
        actions: [
          { label: "Overwrite (explicit)", kind: "danger", onClick: function () { setDialog(null); saveMd(path, true); } },
          { label: "Cancel", onClick: function () { setDialog(null); } },
        ],
      });
    }

    // ---- Stage 5B: compare view ------------------------------------------

    function openCompare(tab) {
      apiGet("/fs/file", { path: tab.path, workspace: tab.workspace || (ws ? ws.id : undefined) })
        .then(function (res) {
          if (!res.ok) return;
          var f = res.body;
          var localText = "";
          if (tab.kind === "md") {
            var e6 = refs.current.md.get(tab.path);
            var MD = window.__HERMES_EDITOR_MD__;
            localText = (e6 && MD) ? MD.serializeMarkdown(e6.api.toJSON()).markdown : "";
          } else {
            var model = refs.current.models.get(tab.path);
            localText = model ? model.getValue() : (tab.content || "");
          }
          var vp = "__diff__/" + tab.path;
          setTabs(function (prev) {
            var existing = prev.filter(function (t2) { return t2.path === vp; })[0];
            if (existing) { setActivePath(vp); return prev.map(function (t3) {
              return t3.path === vp ? Object.assign({}, t3, {
                localContent: localText, diskContent: f.content == null ? "" : f.content,
              }) : t3;
            }); }
            var diffTab = {
              path: vp, name: "Compare " + stem(tab.path), kind: "diffview",
              status: "text", diffFor: tab.path,
              workspace: tab.workspace || (ws ? ws.id : undefined),
              localContent: localText,
              diskContent: f.content == null ? "" : f.content,
              language: tab.kind === "md" ? "plaintext" : languageFor(tab.name),
              revision: "", size: f.size,
            };
            setActivePath(vp);
            return prev.concat([diffTab]);
          });
        });
    }

    function mountDiffView(el, diffTab) {
      var r = refs.current;
      if (!el || !window.__HERMES_EDITOR_MONACO__) return;
      var monaco = window.__HERMES_EDITOR_MONACO__;
      if (!r.diffEditor || !r.diffEditor._heAlive) {
        if (r.diffEditor) { try { r.diffEditor.dispose(); } catch (_e0) {} }
        r.diffEditor = monaco.editor.createDiffEditor(el, {
          readOnly: true, renderSideBySide: true, automaticLayout: true,
          originalEditable: false, enableSplitViewResizing: true,
        });
        r.diffEditor._heAlive = true;
        r.diffModels = null;
      }
      // opening Compare must NEVER modify either side: fresh read-only models
      if (r.diffModels) {
        try { r.diffModels.original.dispose(); r.diffModels.modified.dispose(); } catch (_e1) {}
      }
      var om = monaco.editor.createModel(diffTab.localContent || "",
        diffTab.language || "plaintext");
      var mm = monaco.editor.createModel(diffTab.diskContent || "",
        diffTab.language || "plaintext");
      r.diffModels = { original: om, modified: mm };
      r.diffEditor.setModel({ original: om, modified: mm });
    }

    useEffect(function () {
      function onKey(e) {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === "s") {
          e.preventDefault(); e.stopPropagation();
          saveActiveRef.current();
        }
      }
      document.addEventListener("keydown", onKey, true);
      return function () { document.removeEventListener("keydown", onKey, true); };
    }, []);

    // ---- workspace switching / management --------------------------------------

    function pickWorkspace(next) {
      setWsMenuOpen(false);
      if (!next || (ws && next.id === ws.id)) return;
      var dirtyTabs = tabs.filter(function (t2) { return !t2.diskViewFor && isDirty(t2.path); });
      function doSwitch() {
        // discard tabs belonging to the old workspace only after explicit OK
        refs.current.models.forEach(function (m) { m.dispose(); });
        refs.current.models.clear(); refs.current.savedVersion.clear();
        refs.current.viewStates.clear();
        refs.current.md.forEach(function (e3) { try { e3.api.destroy(); } catch (_e) {} });
        refs.current.md.clear();
        setTabs([]);
        setActivePath(null);
        setWs(next);
      }
      if (dirtyTabs.length) {
        setDialog({
          title: "Unsaved changes",
          message: dirtyTabs.length + " tab(s) have unsaved edits in \"" + (ws ? ws.label : "") +
            "\". Switching workspaces will close them.",
          actions: [
            { label: "Switch and discard", kind: "danger", onClick: function () { setDialog(null); doSwitch(); } },
            { label: "Stay", onClick: function () { setDialog(null); } },
          ],
        });
        return;
      }
      doSwitch();
    }

    useEffect(function () {
      window.HermesEditorOpenFile = function (request) {
        if (!request || typeof request.path !== "string") return;
        var next = workspaces.filter(function (w2) { return w2.id === request.workspace; })[0];
        if (!next) { window.__HERMES_EDITOR_PENDING_OPEN__ = request; return; }
        if (!ws || ws.id !== next.id) {
          window.__HERMES_EDITOR_PENDING_OPEN__ = request;
          pickWorkspace(next);
          return;
        }
        delete window.__HERMES_EDITOR_PENDING_OPEN__;
        openFile({ type: "file", path: request.path,
          name: request.path.split("/").pop() || request.path });
      };
      window.HermesEditorManageWorkspaces = function () { setManageOpen(true); };
      window.HermesEditorSelectWorkspace = function (id) {
        var next = workspaces.filter(function (w2) { return w2.id === id; })[0];
        if (next) pickWorkspace(next);
        else window.__HERMES_EDITOR_PENDING_WORKSPACE__ = id;
      };
      var pending = window.__HERMES_EDITOR_PENDING_OPEN__;
      if (pending) window.HermesEditorOpenFile(pending);
      var pendingWorkspace = window.__HERMES_EDITOR_PENDING_WORKSPACE__;
      if (pendingWorkspace) {
        var pendingNext = workspaces.filter(function (w2) { return w2.id === pendingWorkspace; })[0];
        if (pendingNext) { delete window.__HERMES_EDITOR_PENDING_WORKSPACE__; pickWorkspace(pendingNext); }
      }
      return function () {
        if (window.HermesEditorOpenFile) delete window.HermesEditorOpenFile;
        if (window.HermesEditorManageWorkspaces) delete window.HermesEditorManageWorkspaces;
        if (window.HermesEditorSelectWorkspace) delete window.HermesEditorSelectWorkspace;
      };
    }, [workspaces, ws]);

    function openManage(editWs) {
      setManageErr("");
      if (editWs) {
        setManageEdit(editWs);
        setManageFields({
          id: editWs.id, label: editWs.label || editWs.id,
          host: editWs.provider === "local" ? "" : (editWs.host || ""),
          root: editWs.root || "",
          enabled: editWs.enabled !== false,
          index_markdown: editWs.index_markdown !== false,
        });
      } else {
        setManageEdit(null);
        setManageFields(newFields());
      }
      setManageOpen(true);
    }

    function saveWorkspaceFromDialog() {
      var f2 = manageFields;
      var id = manageEdit ? manageEdit.id : (f2.id.trim() || slugify(f2.label));
      var spec = {
        id: id, label: (f2.label.trim() || id),
        enabled: f2.enabled, index_markdown: f2.index_markdown,
      };
      if (f2.host) {
        spec.provider = "ssh";
        spec.host = f2.host;
        spec.root = f2.root.trim();
      } else {
        spec.provider = "local";
      }
      apiSend("POST", "/workspaces", spec).then(function (res) {
        if (!res.ok) {
          setManageErr((res.body && res.body.detail) ? String(res.body.detail) : "Save failed (" + res.status + ")");
          return;
        }
        setManageOpen(false);
        refreshHealth().then(function () {
          apiGet("/workspaces").then(function (r2) {
            if (!r2.ok) return;
            var nw = (r2.body.workspaces || []).filter(function (w3) { return w3.id === id; })[0];
            if (nw) pickWorkspace(nw);
          });
        });
      }).catch(function () { setManageErr("Save failed (network)"); });
    }

    function removeWorkspace(w2) {
      setDialog({
        title: "Remove workspace",
        message: "Remove \"" + w2.label + "\" from the editor? Files on the host are NOT touched.",
        actions: [
          {
            label: "Remove", kind: "danger", onClick: function () {
              setDialog(null);
              apiSend("DELETE", "/workspaces/" + encodeURIComponent(w2.id)).then(function () {
                if (ws && ws.id === w2.id) {
                  var remaining = workspaces.filter(function (w4) { return w4.id !== w2.id; });
                  setTabs([]); setActivePath(null); setWs(remaining[0] || null);
                }
                refreshHealth();
              });
            },
          },
          { label: "Cancel", onClick: function () { setDialog(null); } },
        ],
      });
    }

    // ---- derived render data ---------------------------------------------------

    var activeTab = tabs.filter(function (t2) { return t2.path === activePath; })[0] || null;
    var mdReady = monacoState === "ready" && bundleState === "ready" &&
                  !!refs.current.md.get(activePath);
    var unsupportedCount = 0;
    if (activeTab && activeTab.kind === "md") {
      var ae = refs.current.md.get(activePath);
      if (ae) unsupportedCount = ae.api.countUnsupported();
    }
    var blList = activeTab && isMarkdown(activeTab.name) ? computeBacklinks(activeTab.path) : [];

    // ---- render ------------------------------------------------------------------

    return h("div", { className: "he-page he-editor-page" },
      h(Modal, {
        open: !!dialog,
        spec: dialog ? Object.assign({}, dialog, {
          actions: (dialog.actions || [{ label: "OK", onClick: function () { setDialog(null); } }]),
        }) : null,
        onInput: function (v) { dlgRef.current.specInput = v; },
      }),
      manageOpen ? h(ManageWorkspacesDialog, {
        editing: manageEdit, fields: manageFields, setFields: setManageFields,
        hosts: hosts, workspaces: workspaces, error: manageErr,
        onSave: saveWorkspaceFromDialog,
        onClose: function () { setManageOpen(false); },
        onEdit: function (w2) { openManage(w2); },
        onRemove: removeWorkspace,
      }) : null,
      h("div", { className: "he-editor-layout" },
        h(FileTree, {
          ws: ws, workspaces: workspaces, wsStatuses: wsStatuses,
          wsMenuOpen: wsMenuOpen, setWsMenuOpen: setWsMenuOpen,
          wsOffline: !!(ws && (wsStatuses[ws.id] || {}).online === false),
          treeEntries: treeEntries, treeStatus: treeStatus,
          expanded: expanded, childrenCache: cacheRef.current,
          activeDir: actDir[0], activePath: activePath,
          onActivate: openFile,
          onPickWorkspace: pickWorkspace,
          onManage: function () { setWsMenuOpen(false); openManage(null); },
          onRefreshHealth: function () { setWsMenuOpen(false); refreshHealth(); },
        }),
        h("div", { className: "he-main" },
          h("div", { className: "he-tabs" },
            tabs.map(function (t2) {
              var dirty = t2.diskViewFor ? false : isDirty(t2.path);
              return h("div", {
                key: t2.path,
                className: "he-tab" + (t2.path === activePath ? " he-tab-active" : ""),
                onClick: function () { setActivePath(t2.path); },
                title: t2.path,
              },
                h("span", { className: "he-tab-name" }, t2.diskViewFor ? "(disk) " + stem(t2.diskViewFor) : t2.name),
                dirty ? h("span", { className: "he-dirty-dot", title: "unsaved changes" }) : null,
                h("button", {
                  className: "he-tab-close", title: "Close",
                  onClick: function (e2) { e2.stopPropagation(); closeTab(t2.path); },
                }, "x")
              );
            })
          ),
          h("div", { className: "he-editor-zone" },
            activeTab && (activeTab.conflict || activeTab.resyncRequired)
              ? h("div", { className: "he-conflict-bar" +
                  (activeTab.conflict ? "" : " he-conflict-info") },
                h("span", { className: "he-conflict-msg" },
                  activeTab.conflict
                    ? "Conflict: this file changed on disk while you had unsaved edits."
                    : "File was moved/renamed externally - path could not be confirmed."),
                activeTab.conflict ? h("button", {
                  className: "he-btn he-btn-small",
                  onClick: function () { openCompare(activeTab); },
                }, "Compare") : null,
                activeTab.conflict ? h("button", {
                  className: "he-btn he-btn-small",
                  onClick: function () { resolveTakeDisk(activeTab.path); },
                }, "Reload disk version") : null,
                activeTab.conflict ? h("button", {
                  className: "he-btn he-btn-small he-btn-danger",
                  onClick: function () { resolveOverwrite(activeTab.path); },
                }, "Overwrite mine (explicit)") : null,
                activeTab.resyncRequired ? h("button", {
                  className: "he-btn he-btn-small",
                  onClick: function () {
                    updateTab(activeTab.path, { resyncRequired: false });
                    reloadTab(activeTab.path, false);
                    if (syncRef.current) syncRef.current.requestResubscribe();
                  },
                }, "Resync") : null
              ) : null,
            activeTab && activeTab.kind === "diffview"
              ? h("div", { className: "he-diff-wrap" },
                  h("div", { className: "he-diff-note" },
                    "Read-only compare. Left: your version. Right: disk version. Opening Compare never modifies either side."),
                  h("div", {
                    className: "he-diff-host",
                    ref: function (el) { mountDiffView(el, activeTab); },
                  }))
              : null,
            activeTab && activeTab.kind === "md"
              ? h("div", { className: "he-mdwrap" },
                  h(MdToolbar, {
                    api: refs.current.md.get(activePath) ? refs.current.md.get(activePath).api : null,
                    onCmd: function (name) {
                      var e3 = refs.current.md.get(activePath);
                      if (!e3) return;
                      if (name === "wikilink") e3.api.insertWiki({ target: "", heading: null, alias: null });
                      else e3.api.run(name);
                      refreshSoon();
                    },
                    onLink: function () {
                      var e3 = refs.current.md.get(activePath); if (!e3) return;
                      var href2 = window.prompt("Link URL:");
                      if (href2 != null) e3.api.run("link", href2);
                      refreshSoon();
                    },
                    findQ: fQ, setFQ: setFQ, repQ: rQ, setRQ: setRQ,
                    onReplaceAll: function () {
                      var e3 = refs.current.md.get(activePath); if (!e3) return;
                      var n2 = e3.api.replaceAll(fQ, rQ);
                      setDialog({ title: "Replace all", message: n2 + " replacement(s).", actions: [{ label: "OK", onClick: function () { setDialog(null); } }] });
                      refreshSoon();
                    },
                  }),
                  h("div", { id: "he-md-host", className: "he-mdhost" +
                    (mdReady ? "" : " he-hidden") }),
                  !mdReady ? h("div", { className: "he-editor-loading" },
                    bundleState === "failed" ? "Markdown engine failed to load." : "Loading editor...") : null
                )
              : null,
            activeTab && activeTab.status === "text" &&
            activeTab.kind !== "md" && activeTab.kind !== "diffview"
              ? h("div", { className: "he-editor-wrap" },
                  h("div", {
                    className: "he-monaco-host",
                    ref: function (el) { refs.current.container = el; },
                  }))
              : null,
            activeTab && activeTab.status !== "text"
              ? h(FallbackView, {
                  info: activeTab,
                  onClose: closeTabInternal,
                  onReloadAsText: null,
                })
              : null,
            !activeTab ? h("div", { className: "he-empty" }, "Open a file from the tree.") : null
          ),
          h("div", { className: "he-statusbar" },
            ws ? h("span", { className: "he-status-ws", title: ws.root_display || "" },
              h(WorkspaceDot, {
                online: (wsStatuses[ws.id] || {}).online,
                title: ((wsStatuses[ws.id] || {}).endpoint || ""),
              }),
              " " + ws.label + (ws.host && ws.provider !== "local" ? "@" + ws.host : "") +
              ((wsStatuses[ws.id] || {}).endpoint
                ? " (" + (wsStatuses[ws.id] || {}).endpoint + ")" : "")) : null,
            activeTab ? h("span", null, activeTab.path) : h("span", null, ""),
            activeTab && !activeTab.diskViewFor ?
              h("span", { className: isDirty(activeTab.path) ? "he-status-dirty" : "he-status-clean" },
                isDirty(activeTab.path)
                  ? (activeTab.kind === "md" ? "modified - Ctrl+S saves Markdown" : "modified - Ctrl+S to save")
                  : "saved")
              : null,
            unsupportedCount > 0 ? h("span", { className: "he-unsupported-note", title: "Preserved verbatim - they will not be altered on save." },
              unsupportedCount + " preserved construct(s)") : null,
            indexData.status !== "ready" ? h("span", null, "index: " + indexData.status) :
              h("span", null, indexData.entries.length + " pages indexed"),
            h("button", { className: "he-btn he-btn-small", title: "Rebuild workspace index",
              onClick: function () { loadIndex(true); } }, "Index"),
            activeTab && isMarkdown(activeTab.name) ? h("button", {
              className: "he-btn he-btn-small", onClick: function () { setBlOpen(!blOpen); },
            }, "Backlinks" + (blList.length ? " (" + blList.length + ")" : "")) : null,
            activeTab && isMarkdown(activeTab.name) ? h("button", {
              className: "he-btn he-btn-small", onClick: renameCurrent,
            }, "Rename") : null,
            activeTab && !activeTab.diskViewFor ? h("button", {
              className: "he-btn he-btn-small", onClick: function () { reloadTab(activeTab.path, false); },
            }, "Reload") : null
          ),
          blOpen && activeTab && isMarkdown(activeTab.name) ? h("div", { className: "he-backlinks" },
            h("div", { className: "he-backlinks-title" }, "Pages linking here"),
            blList.length === 0 ? h("div", { className: "he-backlink-none" }, "No backlinks.") :
            blList.map(function (b2) {
              return h("div", {
                key: b2.path, className: "he-backlink-row",
                onClick: function () { openFile({ type: "file", path: b2.path, name: b2.path.split("/").pop() }); },
              }, b2.path);
            })
          ) : null
        )
      )
    );
  }

  function FallbackView(props) {
    var info = props.info;
    var why = info.encoding === "binary"
      ? "This file looks binary (NUL bytes or invalid UTF-8)."
      : "This file is " + info.size + " bytes, above the text limit.";
    return h("div", { className: "he-fallback" },
      h("p", { className: "he-fallback-title" }, info.path),
      h("p", null, why),
      h("p", { className: "he-fallback-hint" }, "It will not be opened in an editor."),
      h("button", { className: "he-btn", onClick: function () { props.onClose(info.path); } }, "Close tab"));
  }

  registry.register("hermes-editor", HermesEditorPage);
})();
