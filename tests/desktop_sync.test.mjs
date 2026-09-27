import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSync } from '../desktop/src/sync.mjs'

test('Desktop sync falls back to bounded revision polling', async () => {
  const ctx = {
    async rest(path) {
      assert.equal(path, '/fs/revisions?workspace=stage6-acceptance&paths=fences.md')
      return { stats: [{ path: 'fences.md', exists: true, revision: 'rev-2' }] }
    }
  }
  const events = []
  const sync = createSync(ctx, 5)
  const unsubscribe = sync.subscribe('stage6-acceptance', 'fences.md', 'rev-1', event => events.push(event))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(events.some(event => event.type === 'file.changed' && event.revision === 'rev-2'))
  unsubscribe()
  sync.dispose()
})

test('noteWritten updates the poll baseline so own saves never conflict', async () => {
  const revisions = ['rev-1', 'rev-1', 'rev-2', 'rev-2']
  const ctx = {
    async rest() {
      return { stats: [{ path: 'fences.md', exists: true, revision: revisions.shift() || 'rev-2' }] }
    }
  }
  const events = []
  const sync = createSync(ctx, 5)
  const unsubscribe = sync.subscribe('stage6-acceptance', 'fences.md', 'rev-1', event => events.push(event))
  await new Promise(resolve => setTimeout(resolve, 15))
  // Simulate our own save landing at rev-2 before the next poll sees it.
  sync.noteWritten('stage6-acceptance', 'fences.md', 'rev-2')
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(events.filter(event => event.type === 'file.changed').length, 0)
  unsubscribe()
  sync.dispose()
})
