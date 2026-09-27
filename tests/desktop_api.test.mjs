import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editorApi } from '../desktop/src/api.mjs'

test('Desktop editor routes reads and writes to the selected workspace', async () => {
  const calls = []
  const ctx = { rest: async (...args) => { calls.push(args); return { ok: true } } }
  const api = editorApi(ctx)
  await api.get({ workspace: 'stage6-acceptance', path: 'fences.md' })
  await api.put(
    { workspace: 'stage6-acceptance' },
    { path: 'fences.md', content: '# edited', base_revision: 'rev-1', force: false }
  )
  assert.deepEqual(calls, [
    ['/fs/file?workspace=stage6-acceptance&path=fences.md'],
    ['/fs/file?workspace=stage6-acceptance', {
      method: 'PUT',
      body: { path: 'fences.md', content: '# edited', base_revision: 'rev-1', force: false }
    }]
  ])
})
