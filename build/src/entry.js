/* hermes-editor browser bundle entry.
 *
 * Produces dist/bundle.js (IIFE). Attaches:
 *   window.__HERMES_EDITOR_MD__  - pure markdown <-> doc JSON core
 *   window.__HERMES_EDITOR_UI__  - ProseMirror WYSIWYG factory (md-ui)
 * React is NOT bundled anywhere in this file; the dashboard SDK's React
 * remains the only runtime. Monaco is untouched and stays lazy.
 */
"use strict";

var core = require("./md-core.js");
require("./md-ui.js");
var ui = globalThis.__HERMES_EDITOR_UI__;

var libs = {
  Model: require("prosemirror-model"),
  State: require("prosemirror-state"),
  View: require("prosemirror-view"),
  History: require("prosemirror-history"),
  Keymap: require("prosemirror-keymap"),
  Commands: require("prosemirror-commands"),
  SchemaList: require("prosemirror-schema-list"),
};

ui.initPM(libs);

globalThis.__HERMES_EDITOR_MD__ = core;
