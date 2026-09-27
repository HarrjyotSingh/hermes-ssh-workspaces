import test from 'node:test'
import assert from 'node:assert/strict'
import { createFileOperations, isDotHiddenPath, isExplorerPathHidden, normalizeExplorerPath } from '../desktop/src/file-operations.mjs'

function fakeContext(respond = () => ({ entries: [] })) {
  const calls = []
  const data = new Map()
  return {
    calls,
    data,
    ctx: {
      rest: async (path, options) => {
        calls.push({ path, options })
        return respond(path, options)
      },
      storage: {
        get(key, fallback) { return data.has(key) ? data.get(key) : fallback },
        set(key, value) { data.set(key, value) }
      }
    }
  }
}

test('path normalization rejects absolute, drive, traversal, and control paths', () => {
  assert.equal(normalizeExplorerPath('notes\\draft.md'), 'notes/draft.md')
  assert.equal(normalizeExplorerPath('a/./b'), 'a/b')
  for (const path of ['/etc/passwd', '\\server\\share', 'C:\\notes\\a.md', '../secret', 'a/../../secret', 'bad\0name']) {
    assert.throws(() => normalizeExplorerPath(path), /workspace-relative|leave the workspace|invalid character/)
  }
  assert.throws(() => normalizeExplorerPath('', { allowEmpty: false }), /required/)
})

test('hidden-name detection uses dotfiles and dotfolders, not gitignore rules', () => {
  assert.equal(isDotHiddenPath('.env'), true)
  assert.equal(isDotHiddenPath('.config/settings.json'), true)
  assert.equal(isDotHiddenPath('notes/.private/draft.md'), true)
  assert.equal(isDotHiddenPath('build/output.md'), false)
  assert.equal(isDotHiddenPath('ignored-by-git.md'), false)
})

test('list addresses the REST tree route and normalizes only direct child entries', async () => {
  const { ctx, calls } = fakeContext(() => ({ entries: [
    { name: 'file.md', type: 'file' },
    { path: 'docs/sub', name: 'sub', is_dir: true },
    { path: 'elsewhere/file.md', name: 'escape', type: 'file' },
    { path: '../outside', name: 'bad', type: 'file' }
  ] }))
  const ops = createFileOperations(ctx)
  const entries = await ops.list({ id: 'notes' }, 'docs')
  assert.equal(calls[0].path, '/fs/tree?path=docs&workspace=notes')
  assert.deepEqual(entries.map(({ name, path, isDirectory }) => ({ name, path, isDirectory })), [
    { name: 'file.md', path: 'docs/file.md', isDirectory: false },
    { name: 'sub', path: 'docs/sub', isDirectory: true }
  ])
})

test('create, delete, and move use the plugin REST API request shapes', async () => {
  const { ctx, calls } = fakeContext((path) => path.startsWith('/fs/move') ? { from: 'draft.md', to: 'archive/draft.md' } : { ok: true })
  const ops = createFileOperations(ctx)
  await ops.createFile({ id: 'local' }, 'draft.md', 'hello')
  await ops.createFolder({ id: 'local' }, 'archive')
  await ops.remove({ id: 'local' }, 'old.md')
  await ops.move({ id: 'local' }, 'draft.md', 'archive')
  assert.deepEqual(calls.map(call => [call.path, call.options?.method, call.options?.body]), [
    ['/fs/file?workspace=local', 'PUT', { path: 'draft.md', content: 'hello', base_revision: '', force: false }],
    ['/fs/mkdir?workspace=local', 'POST', { path: 'archive' }],
    ['/fs/delete?workspace=local', 'POST', { path: 'old.md' }],
    ['/fs/move?workspace=local', 'POST', { from: 'draft.md', to: 'archive/draft.md' }]
  ])
})

test('hidden paths are plugin-only, workspace scoped, inherited by descendants, and follow directory moves', async () => {
  const { ctx, calls, data } = fakeContext(() => ({ ok: true, from: 'src', to: 'archive/src' }))
  const ops = createFileOperations(ctx)
  assert.deepEqual(ops.setHidden({ id: 'one' }, 'src', true), ['src'])
  ops.setHidden({ id: 'one' }, 'src/private.md', true)
  ops.setHidden({ id: 'two' }, 'src', true)
  assert.equal(isExplorerPathHidden('src/nested/a.md', ops.hiddenPaths({ id: 'one' })), true)
  assert.deepEqual(ops.setHidden({ id: 'one' }, 'src', false), ['src/private.md'])
  ops.setHidden({ id: 'one' }, 'src', true)
  assert.deepEqual(ops.setHidden({ id: 'one' }, 'src/private.md', false), [])
  ops.setHidden({ id: 'one' }, 'src/private.md', true)
  await ops.move({ id: 'one' }, 'src', 'archive')
  assert.deepEqual(ops.hiddenPaths({ id: 'one' }), ['archive/src/private.md'])
  assert.deepEqual(ops.hiddenPaths({ id: 'two' }), ['src'])
  assert.equal(calls.length, 1)
  assert.deepEqual(data.get('file-explorer.hidden-paths.v1'), {
    one: ['archive/src/private.md'], two: ['src']
  })
})

test('invalid destinations and REST failures surface without being converted to success', async () => {
  const { ctx } = fakeContext(() => { throw new Error('backend unavailable') })
  const ops = createFileOperations(ctx)
  await assert.rejects(ops.move({ id: 'local' }, 'folder', 'folder/child'), /descendants/)
  await assert.rejects(ops.remove({ id: 'local' }, '../outside'), /leave the workspace/)
  assert.throws(() => ops.createFolder({ id: 'local' }, '/absolute'), /workspace-relative/)
  await assert.rejects(ops.list({ id: 'local' }), /backend unavailable/)
})

test('rename stays within the workspace and updates hidden descendants', async () => {
  const { ctx, calls } = fakeContext(() => ({ from: 'drafts', to: 'notes' }))
  const ops = createFileOperations(ctx)
  ops.setHidden({ id: 'local' }, 'drafts/private.md', true)
  await ops.rename({ id: 'local' }, 'drafts', 'notes')
  assert.deepEqual(ops.hiddenPaths({ id: 'local' }), ['notes/private.md'])
  assert.deepEqual(calls[0].options.body, { from: 'drafts', to: 'notes' })
  await assert.rejects(ops.rename({ id: 'local' }, 'notes', '../escape'), /single valid/)
})
