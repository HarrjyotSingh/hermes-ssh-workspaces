import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../desktop/src/plugin.js', import.meta.url), 'utf8')
const workspaces = fs.readFileSync(new URL('../desktop/src/workspaces.mjs', import.meta.url), 'utf8')

test('Desktop integration uses only the public workspace, picker, and contribution doors', () => {
  assert.match(source, /PALETTE_AREA/)
  assert.match(source, /ctx\.os\.pickOpenPath/)
  assert.match(source, /sdkHost\.openWorkspace/)
  assert.match(source, /ctx\.onDispose\(\(\) => tab\.close\?\.\(\)\)/)
  assert.match(source, /id: 'hermes-editor\.open-file'/)
  assert.match(source, /sdkHost\.openWorkspace\('hermes-editor:browser'/)
  assert.match(source, /ctx\.setTimeout\(showEditorWorkspace, 0\)/)
  assert.doesNotMatch(source, /ctx\.preview\./)
  assert.doesNotMatch(workspaces, /ctx\.preview\./)
})

test('fileWorkspace stays optional while the public picker owns file selection', () => {
  assert.match(source, /if \(ctx\.fileWorkspace\)/)
  assert.match(source, /onOpenFile: workspace => pickEditorFile\(ctx, sync, workspaces, workspace\)/)
  assert.match(source, /Choose a file inside a configured Hermes Editor workspace/)
})

test('the plugin file browser opens SSH workspace files and disables the backend-local picker there', () => {
  assert.match(source, /onOpenExplorerFile: \(workspace, path\) => openEditorWorkspace\(ctx, sync, workspaces, workspace, path\)/)
  assert.match(source, /disabled: active\.provider === 'ssh'/)
  assert.match(source, /active\.provider === 'ssh' \? 'Open below' : 'Open file'/)
})
