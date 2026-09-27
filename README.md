# Hermes SSH Workspaces

SSH workspace and editor integration for Hermes Desktop. The plugin lets you configure remote SSH machines, add workspace roots, and edit files across local and remote workspaces.

Repository: `hermes-ssh-workspaces`

## SSH setup

Open the **Workspaces** pane and choose **Add workspace**. Select **Add SSH machine…**, enter a machine ID, SSH username, and one or more hostnames or IP endpoints, then enter an absolute directory path on that machine. The plugin uses your system OpenSSH configuration and keys; private keys are not stored in this repository or sent to the plugin UI.



Update-safe external Hermes dashboard plugin. Lives entirely outside the
Hermes core repository (`~/.hermes/hermes-agent`) and is installed as a
separate Git checkout under the supported user-plugins root
(`~/.hermes/plugins/hermes-editor`). Hermes updates therefore cannot
overwrite or revert it.

## Stage 5A scope (multi-machine workspaces)

- `WorkspaceProvider` abstraction (`dashboard/hecore/providers/`):
  stat/list/read/revision/atomic-write/mkdir/rename/delete/bounded index
  scan/health/capabilities, shared by local and SSH backends
- Persistent host/workspace registry
  (`~/.hermes/hermes-editor-state/workspace-config.json`, JSON): hosts
  (provider kind + user + ordered endpoints) separate from workspaces
  (stable id, label, host, remote root, enabled, index_markdown).
  Workspaces can be added/edited/removed at runtime from the UI; no
  source changes needed for new roots on either machine
- Lightweight OpenSSH provider: `BatchMode=yes`, short connect timeout,
  ControlMaster multiplexing, strict host-key checking, no password
  fallback. A tiny structured-JSON Python helper is piped to each host
  once (temp file under its own `/tmp` - not an installed service);
  filenames never touch a shell command line
- Ethernet-preferred / Tailscale-fallback endpoint policy with
  exponential-backoff hysteresis and automatic recovery. One operation ==
  one SSH invocation against one endpoint; after failover the whole
  operation (including revision validation) re-runs on the new endpoint.
  Offline workspaces keep open tabs but disable saving; no local Pi copy
  is ever created as fallback
- Atomic remote writes: compare-and-swap revision validation -> temp file
  (identifiable `.hermes-editor-tmp-*`) on the same filesystem -> fsync ->
  atomic rename; temp files cleaned on failure
- `/fs/*` API is workspace-id addressed; registry CRUD at
  `/workspaces*`; health/active-endpoint per workspace. No SSH
  credentials or keys ever cross the API boundary; arbitrary
  frontend-supplied absolute roots are rejected
- Editor selection stays FILE-TYPE based: `.md` opens the Stage 4
  WYSIWYG editor on any host; code files open Monaco

## Stage 4 scope

- WYSIWYG ProseMirror markdown editing backed by the pure
  markdown<->JSON core in bundle.js; ordinary portable Markdown on disk,
  round-trip gate, unsupported/raw-node preservation
- Wikilinks, aliases, heading links, backlinks, broken-link state;
  bounded on-demand per-workspace index (~5000-file cap)

## Stage 3 scope

- Client-side Monaco editor (vendored monaco-editor@0.52.2 min/vs under
  `dashboard/dist/monaco/`, loaded lazily through the plugin asset route;
  nothing Monaco-related runs inside any Python process)
- Languages: Python, C/C++, YAML, JSON, Dockerfile, Docker Compose (yaml),
  shell, plain text
- File tree (lazy), tabs, Ctrl+S save, dirty indicators, undo/redo,
  search/replace (all Monaco built-ins)
- Stale-revision detection: reads return a SHA-256 revision; writes carry
  the base revision; mismatches return 409 and the UI offers
  reload / overwrite-anyway / cancel
- Binary and oversized (>2 MB) files get a fallback view, never fed to Monaco

## Hard constraints (update-safety contract)

- No new listening ports; routes ride the existing dashboard process
- No microphone/audio capture, no wake-word APIs
- No editor-identity exceptions in Hermes core. The desktop half is discovered
  through the generic unified-plugin API, and its activation follows the same
  `plugins.enabled` allow-list as the backend half.
- No modifications to Jarvis voice code, jarvis-dashboard, or Community WebUI
  source
- All contribution IDs prefixed `hermes-editor.*`

## Install and update

The installed plugin must be a normal Git checkout on `main` with an
`origin` remote. Do not install it as a symlink: the dashboard's **Update**
button runs `git pull --ff-only` inside `~/.hermes/plugins/hermes-editor`.

Install the public repository as a normal Git checkout. This plugin requires
a Hermes version that supports external dashboard and Desktop runtime plugins.
SSH workspaces additionally require OpenSSH on the Hermes backend, key-based
SSH access to each remote machine, and Python 3 on each remote machine.

```bash
git clone --branch main \
  https://github.com/HarrjyotSingh/hermes-ssh-workspaces.git \
  ~/.hermes/plugins/hermes-editor
git -C ~/.hermes/plugins/hermes-editor config pull.ff only
```

Enable:

```bash
python - <<'PY'
from hermes_cli.config import load_config, save_config
c = load_config()
enabled = set((c.get("plugins") or {}).get("enabled") or [])
enabled.add("hermes-editor")
c.setdefault("plugins", {})["enabled"] = sorted(enabled)
save_config(c)
PY
systemctl --user restart hermes-serve   # one-time mount of API routes
```

On current Hermes Desktop builds, the same `plugins.enabled` entry enables the
plugin's `desktop/plugin.js` automatically. This is intentionally generic: it
does not require a `hermes-editor` name or allow-list exception in the desktop
source. An explicit Desktop Settings toggle still overrides that default.

### Desktop editor integration

The Desktop half uses only the public `@hermes/plugin-sdk`: the **Workspaces**
pane and the **Open file in Hermes Editor** command-palette action open an
attributed `host.openWorkspace` tab. The pane's file browser opens files from
both local and SSH workspaces; the native file picker and command-palette
action select files on the backend machine, so the picker button is disabled
for SSH workspaces. Clicking a file in the browser opens it in an editor tab.
Markdown and code editing, revision-conflict handling, sync, workspace
selection, and wiki-link navigation remain inside those tabs. Clicking a wiki
link follows it; Alt-clicking a wiki link exposes its `[[target|alias]]` source
for in-place editing, then restores the rendered link when the editor loses
focus.

Current upstream Desktop no longer exposes a public generic preview-renderer
hook. Consequently, clicking a file in Desktop's built-in file preview does
not automatically replace that preview with Hermes Editor; open it using the
editor's pane or palette action instead. `ctx.fileWorkspace` remains an
optional compatibility bridge when supplied by an older host, but is not
required by the public path.

The Desktop **Files** sidebar's Preview/Source/Edit controls belong to its
built-in viewer; rendered Preview there is read-only. Use the file list below
the editor **Workspaces** pane's selector for the plugin's editable tab. The
plugin also opens a dedicated **Hermes Editor · Workspaces** main tab, and the
command palette action **Show Hermes Editor Workspaces** brings it forward. That
list's **Show hidden files and folders** control reveals dot-prefixed names
independently of Desktop's **Show gitignored files** toggle. If the active
backend cannot provide workspaces, the pane shows the error and a Retry action.

### Releasing an editor change

Make changes in this source checkout, then commit and publish them to its
`main` branch:

```bash
git add <changed-files>
git commit -m "editor: describe the change"
git push origin main
```

After that, the dashboard **Update** button for `hermes-editor` will safely
fast-forward the installed checkout. It never depends on Hermes core's
branch, and it will not overwrite uncommitted edits in the installed plugin.

Disable (takes effect immediately for HTTP requests via the runtime gate;
restart removes the mounted routes):

```bash
hermes plugins disable hermes-editor
```

## Tests

```bash
# Stage 1-4 + Stage 5A offline suites (no remote hosts needed):
python tests/test_smoke.py -v
python tests/test_stage5_offline.py -v

# Markdown round-trip fidelity (Node >= 18, no deps):
node --test tests/md_roundtrip.test.mjs

# Live SSH suite against both hosts / both endpoints (destructive ops
# confined to the stage5 scratch roots on each machine):
HERMES_EDITOR_STAGE5_LIVE=1 python \
    tests/test_stage5_live.py -v
```
