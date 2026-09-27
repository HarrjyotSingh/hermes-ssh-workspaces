# hermes-editor — Community WebUI extension (Stage 5C)

Hosts the existing hermes-editor plugin frontend inside the Community WebUI
as a first-class main-page tab, reusing the Stage 5B backend through a
narrow same-origin bridge.

## Shape

```
Community WebUI page (port 8787 / https://your-webui-host...:8443)
  -> extension assets (/extensions/assets/hermes-editor/...)
     -> rail button "Editor" + #mainEditor main-view + loader
  -> lazy loads the EXISTING plugin frontend:
       /dashboard-plugins/hermes-editor/dist/{index.js,style.css,bundle.js}
       (+ vendored React runtime for the plugin's host-SDK contract)
  -> all API traffic stays same-origin:
       /api/plugins/hermes-editor/*  -> api/editor_bridge.py -> hermes serve
```

No editor functionality is implemented here. This extension is only:

* an additive rail button (`#he5cEditorRailBtn`, deliberately without
  `data-panel` so `ui.js:_syncNavActionMirrors` mirrors it to mobile nav),
* a main-view container following the core `#main<Name>` convention,
* a minimal host-SDK shim (`__HERMES_PLUGIN_SDK__` / `__HERMES_PLUGINS__`)
  backed by a vendored React runtime, and
* view switching via one additive class (`he5c-showing-editor`) on `main.main`.

## What it intentionally does NOT do

* no microphone/getUserMedia/PCM/wake-word/STT/TTS access
* no Jarvis HUD, voice WebSocket, or session hooks touched
* no `:root` or `data-skin` writes; no global key handlers of its own
  (it only suppresses the editor page's Ctrl+S capture while the Editor
  view is closed, so Messaging keeps native behaviour)
* no second filesystem/workspace backend (the bridge is byte pass-through)

## Navigation

* Messaging → Editor → Messaging: editor state (tabs, dirty buffers) is kept;
  the view only hides.
* Editor → Kanban → Editor: any core navigation closes the view (MutationObserver
  on `main.main` class changes + capture-phase click guard).
* Browser history: opening pushes `#editor`; Back/Forward and refresh on
  `#editor` restore the Editor view.

## Requirements

* The WebUI must enable the dashboard plugin (Settings → Plugins → Hermes
  Editor) so `/dashboard-plugins/hermes-editor/*` serves the frontend assets.
* The backend bridge requires `api/editor_bridge.py` plus operator env:
  `HERMES_WEBUI_EDITOR_GATEWAY_USER` / `HERMES_WEBUI_EDITOR_GATEWAY_PASSWORD`
  (dashboard basic-auth credentials; never sent to the browser), optionally
  `HERMES_WEBUI_EDITOR_GATEWAY_URL` (default `http://127.0.0.1:9119`).
