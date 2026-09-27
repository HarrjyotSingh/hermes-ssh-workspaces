import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normNote, rankPages, findEntryByRef, resolveRelativeHref } from '../desktop/src/notes.mjs'
import { readFileSync } from 'node:fs'

test('Wikilink targets resolve across spaces, underscores, and hyphens', () => {
  assert.equal(normNote('Picker Wiki B'), 'picker-wiki-b')
  assert.equal(normNote('picker-wiki-b.md'), 'picker-wiki-b')
  assert.equal(normNote('picker_wiki_b.md'), 'picker-wiki-b')
  assert.equal(normNote('./Picker Wiki B.md#Heading'), 'picker-wiki-b')
  assert.equal(normNote('Notes/My Note.md'), 'notes/my-note')
  assert.equal(normNote(''), '')
  assert.equal(normNote(null), '')
})

test('[[' + ' suggestions rank exact basename above prefix above substring', () => {
  const paths = ['wiki-notes/Home', 'Research/Papers list', 'research/papers-list-2', 'Deep/Nested/Target Note']
  assert.deepEqual(rankPages(paths, 'home').map(x => x.label), ['Home'])
  assert.deepEqual(rankPages(paths, 'target note').map(x => x.label), ['Target Note'])
  assert.deepEqual(rankPages(paths, 'papers').map(x => x.label),
    ['Papers list', 'papers-list-2'])
})

test('[[' + ' suggestions carry folder subtitle and cap at eight', () => {
  const paths = Array.from({ length: 12 }, (_, i) => `d${i}/Alpha`)
  const hits = rankPages(paths, 'alpha')
  assert.equal(hits.length, 8)
  assert.equal(hits[0].label, 'Alpha')
  assert.equal(hits[0].sub, 'd0')
})

test('[[' + ' empty query lists everything, shortest path first', () => {
  const paths = ['a/Very Long Name', 'b/Short']
  assert.deepEqual(rankPages(paths, '').map(x => x.label), ['Short', 'Very Long Name'])
})

const ENTRIES = [
  { path: 'Notes/Papers list.md', title: 'Papers List', aliases: ['bibliography'] },
  { path: 'Deep/Target Note.md' }
]

test('ctrl+click resolves by exact indexed path', () => {
  assert.equal(findEntryByRef(ENTRIES, 'Notes/Papers list').path, 'Notes/Papers list.md')
})

test('ctrl+click resolves by basename anywhere in the space', () => {
  assert.equal(findEntryByRef(ENTRIES, 'Target Note').path, 'Deep/Target Note.md')
  assert.equal(findEntryByRef(ENTRIES, 'target-note.md').path, 'Deep/Target Note.md')
})

test('ctrl+click resolves by title (frontmatter or H1)', () => {
  assert.equal(findEntryByRef(ENTRIES, 'papers list').path, 'Notes/Papers list.md')
  assert.equal((findEntryByRef(ENTRIES, 'papers-list') || {}).path, 'Notes/Papers list.md')
})

test('ctrl+click resolves by alias', () => {
  assert.equal(findEntryByRef(ENTRIES, 'bibliography').path, 'Notes/Papers list.md')
  assert.equal(findEntryByRef(ENTRIES, 'Bibliography').path, 'Notes/Papers list.md')
})

test('ctrl+click returns null only for genuinely absent names', () => {
  assert.equal(findEntryByRef(ENTRIES, 'Ghost Note XYZ'), null)
  assert.equal(findEntryByRef([], 'anything'), null)
  assert.equal(findEntryByRef(null, ''), null)
})

test('relative markdown links resolve against the containing note', () => {
  assert.equal(resolveRelativeHref('a/b/current.md', './Other.md').target, 'a/b/Other')
  assert.equal(resolveRelativeHref('a/b/current.md', '../Math/Matrices.md').target, 'a/Math/Matrices')
  assert.equal(resolveRelativeHref('current.md', 'sibling.md').target, 'sibling')
  // fragment carried through for anchor scrolling
  const r = resolveRelativeHref('a/b/current.md', '../Math/Matrices.md#Pivot Position')
  assert.equal(r.target, 'a/Math/Matrices')
  assert.equal(r.fragment, 'Pivot Position')
  // external / in-page anchors are not our business
  assert.equal(resolveRelativeHref('x.md', 'https://example.com'), null)
  assert.equal(resolveRelativeHref('x.md', '#heading'), null)
  assert.equal(resolveRelativeHref('x.md', ''), null)
  assert.equal(resolveRelativeHref('a/current.md', '../../escape.md'), null)
  assert.deepEqual(resolveRelativeHref('a/current.md', '<Other%20Note.md#Details>'), {
    target: 'a/Other Note', fragment: 'Details'
  })
  assert.equal(resolveRelativeHref('a/current.md', 'Other.md "label"').target, 'a/Other')
})

test('ctrl+click resolves by unique path suffix (ZenNotes ladder)', () => {
  const entries = [
    { path: 'Linear Algebra/Matrices.md' },
    { path: 'Course 1. Module 1 Intro.md' }
  ]
  assert.equal(findEntryByRef(entries, 'linear-algebra/matrices').path, 'Linear Algebra/Matrices.md')
})

test('duplicate names still open an existing note (Obsidian nearest rule)', () => {
  const entries = [
    { path: 'Vault A/Linear Algebra/Matrices.md' },
    { path: 'Vault B/Linear Algebra/Matrices.md' },
    { path: 'Course 1. Module 1 Intro.md' }
  ]
  // Duplicate basenames are NEVER a dead end: deterministic shortest-path
  // pick when there is no folder context.
  assert.equal(findEntryByRef(entries, 'Matrices').path, 'Vault A/Linear Algebra/Matrices.md')
  // Linked from inside the Vault B folder: the local copy wins.
  assert.equal(
    findEntryByRef(entries, 'Matrices', 'Vault B/Linear Algebra').path,
    'Vault B/Linear Algebra/Matrices.md'
  )
  // AppleDouble junk (._Foo.md) never resolves.
  assert.equal(findEntryByRef([{ path: 'x/._Matrices.md' }, { path: 'y/Real.md' }], 'Matrices'), null)
})

test('editor opens wiki chips with a normal click and rehydrates edited syntax on blur', () => {
  const source = readFileSync(new URL('../build/src/md-ui.js', import.meta.url), 'utf8')
  assert.match(source, /if \(!mods\.alt\) \{ opts\.openWiki\(node\.attrs\); return true; \}/)
  assert.match(source, /blur: function \(v\) \{\s*rehydrateWikiLinks\(v\)/)
})

test('following a wiki link opens a separate public host workspace tab', () => {
  const source = readFileSync(new URL('../desktop/src/plugin.js', import.meta.url), 'utf8')
  assert.match(source, /const openNoteInTab = \(nextPath, nextWorkspaceId, anchor = null\) =>/)
  assert.match(source, /openEditorWorkspace\(ctx, sync, workspaces, nextWorkspace, nextPath, anchor\)/)
  assert.match(source, /sdkHost\.openWorkspace\(tabId, \{/)
  assert.match(source, /openNoteInTab\(String\(hit\.path\), hit\.__ws \|\| workspace\.id, navAnchor\)/)
})

test('reopening a linked note reuses its render closure and dirty-tab record', () => {
  const source = readFileSync(new URL('../desktop/src/plugin.js', import.meta.url), 'utf8')
  assert.match(source, /let tab = workspaces\.tabs\?\.get\(tabId\)/)
  assert.match(source, /if \(!tab\) \{[\s\S]*?tab\.render = \(\) => React\.createElement\(DesktopEditor/)
  assert.match(source, /render: tab\.render/)
  assert.match(source, /onDirtyChange: dirty => \{ tab\.dirty = dirty \}/)
  assert.match(source, /if \(isNewTab\) ctx\.onDispose\(\(\) => tab\.close\?\.\(\)\)/)
})

test('wiki source can be edited in place with Alt-click while ordinary click navigates', () => {
  const source = readFileSync(new URL('../build/src/md-ui.js', import.meta.url), 'utf8')
  assert.match(source, /if \(!mods\.alt\) \{ opts\.openWiki\(node\.attrs\); return true; \}/)
  assert.match(source, /dissolveWikiToText\(v, nodePos, node\)/)
  assert.match(source, /blur: function \(v\) \{\s*rehydrateWikiLinks\(v\)/)
})
