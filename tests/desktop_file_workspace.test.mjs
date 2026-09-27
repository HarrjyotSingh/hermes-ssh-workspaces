import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../desktop/src/plugin.js', import.meta.url), 'utf8')

test('editor owns workspace file mutations through its provider', () => {
  for (const route of ['/fs/file', '/fs/mkdir', '/fs/move', '/fs/delete']) {
    assert.match(source, new RegExp(route.replace('/', '\\/'), 'u'))
  }
})
