import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageCandidatePaths, loadWorkspaceImage } from '../desktop/src/images.mjs'

test('image paths resolve beside the note and never escape the workspace', () => {
  assert.deepEqual(imageCandidatePaths('docs/note.md', '../Images/plot.png'), ['Images/plot.png'])
  assert.deepEqual(imageCandidatePaths('docs/note.md', '../Images/plot.png?rev=4'), ['Images/plot.png'])
  assert.deepEqual(imageCandidatePaths('note.md', '../../escape.png'), [])
  assert.deepEqual(imageCandidatePaths('note.md', 'https://site.test/p.png'), [])
})

test('workspace image bytes come from the plugin REST route', async () => {
  const calls = []
  const ctx = { rest: async path => {
    calls.push(path)
    if (path.includes('path=docs%2Fplot.png')) return { data_url: 'data:image/png;base64,AA==' }
    throw Object.assign(new Error('not found'), { status: 404 })
  } }
  const result = await loadWorkspaceImage(ctx, { id: 'notes' }, 'plot.png', 'docs/note.md')
  assert.equal(result, 'data:image/png;base64,AA==')
  assert.equal(calls[0], '/fs/image?workspace=notes&path=docs%2Fplot.png')
})

test('workspace Markdown image references ignore URL query strings', async () => {
  const calls = []
  const ctx = { rest: async path => {
    calls.push(path)
    if (path.includes('path=docs%2Fplot.png')) return { data_url: 'data:image/png;base64,AA==' }
    throw Object.assign(new Error('not found'), { status: 404 })
  } }
  const result = await loadWorkspaceImage(ctx, { id: 'notes' }, 'plot.png?rev=4', 'docs/note.md')
  assert.equal(result, 'data:image/png;base64,AA==')
  assert.equal(calls[0], '/fs/image?workspace=notes&path=docs%2Fplot.png')
})

test('external image URLs retain their query string and bypass workspace API', async () => {
  let called = false
  const result = await loadWorkspaceImage({ rest: async () => { called = true } }, { id: 'notes' }, 'https://site.test/p.png?width=640#preview', 'docs/note.md')
  assert.equal(result, 'https://site.test/p.png?width=640#preview')
  assert.equal(called, false)
})
