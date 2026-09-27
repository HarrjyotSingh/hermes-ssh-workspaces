import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { JSDOM } from '../build/node_modules/jsdom/lib/api.js'

const requireBuild = createRequire(new URL('../build/package.json', import.meta.url))
const { build } = requireBuild('esbuild')

test('the rendered Markdown surface is editable and serializes changes', async () => {
  const result = await build({
    entryPoints: [new URL('../build/src/entry.js', import.meta.url).pathname],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile: 'editor-test.js',
    write: false,
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }
  })
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text
  const dom = new JSDOM('<!doctype html><div id="host"></div>', {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true
  })
  try {
    dom.window.eval(js)
    const md = dom.window.__HERMES_EDITOR_MD__
    const editor = dom.window.__HERMES_EDITOR_UI__.createMdEditor(
      dom.window.document.querySelector('#host'),
      { docJSON: md.parseMarkdown('# Heading\n\nInitial text'), onChange() {} }
    )
    try {
      const surface = dom.window.document.querySelector('.ProseMirror')
      assert.equal(surface?.getAttribute('contenteditable'), 'true')
      assert.equal(editor.view.editable, true)
      assert.match(surface.innerHTML, /<h1[^>]*>Heading<\/h1>/)
      editor.view.dispatch(editor.view.state.tr.insertText(' added', editor.view.state.doc.content.size - 1))
      assert.match(surface.textContent, /Initial text added/)
      assert.equal(md.serializeMarkdown(editor.toJSON()).markdown, '# Heading\n\nInitial text added\n')
    } finally {
      editor.destroy()
    }
  } finally {
    dom.window.close()
  }
})
