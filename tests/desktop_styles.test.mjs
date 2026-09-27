import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { installDesktopStyles } from '../desktop/src/styles.mjs'

function fakeDocument() {
  const styles = []
  return {
    head: { append(node) { styles.push(node); node.remove = () => styles.splice(styles.indexOf(node), 1) } },
    createElement() { return { dataset: {}, textContent: '' } },
    querySelector(selector) { return selector === 'style[data-hermes-editor-desktop]' ? styles[0] || null : null },
    querySelectorAll(selector) { return selector === 'style[data-hermes-editor-desktop]' ? styles.slice() : [] }
  }
}

test('Desktop editor styles install once and dispose', async () => {
  const css = await Promise.all([
    readFile(new URL('../build/src/editor.css', import.meta.url), 'utf8'),
    readFile(new URL('../desktop/src/editor.css', import.meta.url), 'utf8')
  ]).then(parts => parts.join('\n'))
  globalThis.document = fakeDocument()
  const disposeFirst = installDesktopStyles(css)
  const disposeSecond = installDesktopStyles(css)
  const styles = document.querySelectorAll('style[data-hermes-editor-desktop]')
  assert.equal(styles.length, 1)
  assert.ok(styles[0].textContent.length > 0)
  assert.match(styles[0].textContent, /\.he-prosemirror/)
  assert.doesNotMatch(styles[0].textContent, /(^|})\s*(html|body|:root)\s*{/m)
  disposeSecond()
  assert.equal(document.querySelectorAll('style[data-hermes-editor-desktop]').length, 1)
  disposeFirst()
  assert.equal(document.querySelector('style[data-hermes-editor-desktop]'), null)
  delete globalThis.document
})
