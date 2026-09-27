import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hydrateWorkspaces, workspaceForPreviewPath } from '../desktop/src/workspaces.mjs'
import { isMountContainer, workspaceProjectRoot } from '../desktop/src/workspaces.mjs'

test('mount namespace is never a Desktop project root', () => {
  assert.equal(isMountContainer('/home/testuser/.hermes/remote-workspaces'), true)
  assert.equal(workspaceProjectRoot([], { provider: 'local', root_display: '/home/testuser/.hermes/remote-workspaces' }), null)
})

test('remote workspace resolves to its concrete mounted child', () => {
  const rows = [{ id: 'local', provider: 'local', root_display: '/home/testuser/.hermes' }]
  assert.equal(workspaceProjectRoot(rows, { id: 'remote-host', provider: 'ssh' }), '/home/testuser/.hermes/remote-workspaces/remote-host')
})

test('workspace discovery does not require the retired preview API', async () => {
  const workspaces = { current: [] }
  const expected = [{ id: 'local', provider: 'local', root_display: '/vault' }]
  const ctx = {
    rest: async path => {
      assert.equal(path, '/workspaces')
      return { workspaces: expected }
    }
  }

  await hydrateWorkspaces(ctx, workspaces)

  assert.equal(workspaces.current, expected)
})

test('failed workspace discovery preserves the fallback', async () => {
  const workspaces = { current: [] }
  const ctx = {
    rest: async () => { throw new Error('offline') }
  }

  await hydrateWorkspaces(ctx, workspaces)

  assert.deepEqual(workspaces.current, [])
})

test('SSH mirror preview paths resolve to their remote workspace', () => {
  const rows = [
    { id: 'local', provider: 'local', root_display: '/home/testuser/.hermes' },
    { id: 'obsidian', provider: 'ssh', root_display: '/home/testuser/Obsidian' }
  ]
  const path = '/home/testuser/.hermes/remote-workspaces/obsidian/Example/Learning/Note.md'

  assert.equal(workspaceForPreviewPath(rows, path)?.id, 'obsidian')
})

test('the most specific local workspace root still wins for ordinary paths', () => {
  const rows = [
    { id: 'local', provider: 'local', root_display: '/home/testuser' },
    { id: 'vault', provider: 'local', root_display: '/home/testuser/Vault' }
  ]

  assert.equal(workspaceForPreviewPath(rows, '/home/testuser/Vault/Note.md')?.id, 'vault')
  assert.equal(workspaceForPreviewPath(rows, '/outside/Note.md'), null)
})
