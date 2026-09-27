import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('LaTeX source activates only for an exact equation selection', async () => {
  const source = await readFile(new URL('../build/src/md-ui.js', import.meta.url), 'utf8')

  assert.match(source, /selection\.node && selection\.from === pos/)
  assert.doesNotMatch(source, /head >= pos - 1/)
  assert.doesNotMatch(source, /pos \+ mv\.size\(\) \+ 1/)
})
