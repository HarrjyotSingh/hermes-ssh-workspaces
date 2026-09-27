import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const readSource = path => readFile(new URL(path, import.meta.url), 'utf8')

test('Desktop Markdown surface stays editable within the host tab', async () => {
  const [plugin, css, markdownUi] = await Promise.all([
    readSource('../desktop/src/plugin.js'),
    readSource('../desktop/src/editor.css'),
    readSource('../build/src/md-ui.js')
  ])

  assert.match(plugin, /md\.current\.view\.setProps\(\{\s*editable:\s*\(\)\s*=>\s*true\s*\}\)/)
  assert.match(css, /\.he-desktop-editor-host\s*\{[^}]*user-select:\s*text/s)
  assert.match(css, /\.he-desktop-editor-host\s*\{[^}]*pointer-events:\s*auto/s)

  // The shared renderer defaults to editable and keeps math/wiki content as
  // custom node views. The Desktop integration restores the host interaction
  // surface without replacing those rendered nodes with source text.
  assert.match(markdownUi, /new View\.EditorView\(hostEl,\s*\{\s*state: state,/)
  assert.match(markdownUi, /math_inline:\s*function/)
  assert.match(markdownUi, /math_block:\s*function/)
  assert.match(markdownUi, /wiki_embed:\s*function/)
})

test('clicked internal Markdown links open through the public Desktop workspace SDK', async () => {
  const plugin = await readSource('../desktop/src/plugin.js')

  assert.match(plugin, /const openNoteInTab\s*=\s*\(nextPath, nextWorkspaceId, anchor = null\)\s*=>/)
  assert.match(plugin, /openEditorWorkspace\(ctx, sync, workspaces, nextWorkspace, nextPath, anchor\)/)
  assert.match(plugin, /addEventListener\('click', onInternalFileLink, true\)/)
  assert.match(plugin, /resolveRelativeHref\(relNotePath, href\)/)
  assert.match(plugin, /openNoteInTab\(resolved\.target, wsId, resolved\.fragment\)/)
  assert.match(plugin, /openNote\(href\)/)
  assert.match(plugin, /sdkHost\.openWorkspace\(tabId,\s*\{/)
})
