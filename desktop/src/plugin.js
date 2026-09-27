import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, PALETTE_AREA, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, host as sdkHost } from '@hermes/plugin-sdk'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution'
import '../../build/src/entry.js'
import { editorApi, query } from './api.mjs'
import { embedCandidatePaths } from './embeds.mjs'
import { FileExplorer } from './file-explorer.mjs'
import { loadWorkspaceImage } from './images.mjs'
import { installDesktopStyles } from './styles.mjs'
import { createSync } from './sync.mjs'
import { normNote, rankPages, findEntryByRef, resolveRelativeHref } from './notes.mjs'
import { hydrateWorkspaces, workspaceForPreviewPath, workspaceProjectRoot } from './workspaces.mjs'

const TEXT_EXTENSIONS = new Set(['c', 'cc', 'cpp', 'cs', 'go', 'h', 'hpp', 'ini', 'java', 'js', 'json', 'jsx', 'py', 'rb', 'rs', 'sh', 'sql', 'ts', 'tsx', 'txt', 'yaml', 'yml'])
const isMarkdown = path => /\.md$/i.test(path || '')
const fileName = target => target.path || target.source || ''
const targetWorkspacePath = target => target.workspace?.relativePath || fileName(target)
const isSupported = target => {
  if (target.kind !== 'file' || target.binary || target.previewKind === 'binary') return false
  const path = targetWorkspacePath(target)
  const base = path.split(/[\\/]/).pop() || ''
  if (isMarkdown(path) || /^dockerfile$/i.test(base) || /(?:docker-)?compose(?:\.[^.]+)?\.ya?ml$/i.test(base)) return true
  return TEXT_EXTENSIONS.has((base.split('.').pop() || '').toLowerCase())
}

function cssColor(value, fallback) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')
  context.fillStyle = fallback
  context.fillStyle = value || fallback
  context.fillRect(0, 0, 1, 1)
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
  return `#${[red, green, blue, alpha].map(value => value.toString(16).padStart(2, '0')).join('')}`
}

function applyMonacoTheme() {
  const styles = getComputedStyle(document.documentElement)
  const dark = styles.colorScheme === 'dark' || document.documentElement.classList.contains('dark')
  const token = (name, fallback) => cssColor(styles.getPropertyValue(name).trim(), fallback)
  const background = token('--ui-editor-surface-background', dark ? '#0d1117' : '#ffffff')
  const foreground = token('--ui-text-primary', dark ? '#e6edf3' : '#24292f')
  const secondary = token('--ui-text-secondary', dark ? '#9ba7b4' : '#57606a')
  const border = token('--ui-stroke-secondary', dark ? '#273142' : '#d0d7de')
  const primary = token('--theme-primary', '#4a84fe')

  monaco.editor.defineTheme('hermes', {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: secondary.slice(1, 7), fontStyle: 'italic' },
      { token: 'keyword', foreground: primary.slice(1, 7) },
      { token: 'string', foreground: dark ? 'A8D279' : '448C27' },
      { token: 'number', foreground: dark ? 'D9A66C' : 'A05A00' },
      { token: 'type', foreground: dark ? '79C0FF' : '0969DA' },
    ],
    colors: {
      'editor.background': background,
      'editor.foreground': foreground,
      'editorCursor.foreground': primary,
      'editor.lineHighlightBackground': `${primary.slice(0, 7)}12`,
      'editor.selectionBackground': `${primary.slice(0, 7)}4d`,
      'editor.inactiveSelectionBackground': `${primary.slice(0, 7)}26`,
      'editorLineNumber.foreground': secondary,
      'editorLineNumber.activeForeground': foreground,
      'editorIndentGuide.background1': border,
      'editorIndentGuide.activeBackground1': primary,
      'editorWidget.background': background,
      'editorWidget.border': border,
      'editorSuggestWidget.background': background,
      'editorSuggestWidget.border': border,
      'editorSuggestWidget.selectedBackground': `${primary.slice(0, 7)}33`,
      'input.background': background,
      'input.border': border,
      'focusBorder': primary,
      'scrollbarSlider.background': `${secondary.slice(0, 7)}33`,
      'scrollbarSlider.hoverBackground': `${secondary.slice(0, 7)}66`,
      'scrollbarSlider.activeBackground': `${primary.slice(0, 7)}66`,
    },
  })
  monaco.editor.setTheme('hermes')
}

function installMonacoTheme() {
  applyMonacoTheme()
  const observer = new MutationObserver(applyMonacoTheme)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
  return () => observer.disconnect()
}

let workerUrl = null
self.MonacoEnvironment = {
  getWorker() {
    workerUrl ??= URL.createObjectURL(new Blob([__HE_MONACO_WORKER__], { type: 'text/javascript' }))
    return new Worker(workerUrl)
  }
}

function languageFor(path) {
  const lower = path.toLowerCase()
  if (/dockerfile$/.test(lower)) return 'dockerfile'
  if (/\.ya?ml$/.test(lower)) return 'yaml'
  if (/\.py$/.test(lower)) return 'python'
  if (/\.(c|h)$/.test(lower)) return 'c'
  if (/\.(cc|cpp|hpp)$/.test(lower)) return 'cpp'
  if (/\.sh$/.test(lower)) return 'shell'
  return monaco.languages.getLanguages().find(language => lower.endsWith(`.${language.id}`))?.id || 'plaintext'
}

function basename(p) {
  return String(p || '').split('/').pop() || p
}

/** Vault-relative path: restored SSH panes can carry a mount-anchor prefix
 *  (remote-workspaces/<id>/…) or the workspace's absolute root — strip it so
 *  relative joins, dead-link creates and disk scans address the VAULT. */
function workspaceRelPath(row, p) {
  let s = String(p || '').replace(/^\/+/, '')
  const low = s.toLowerCase()
  const anchor = 'remote-workspaces/'
  const ai = low.indexOf(anchor)
  if (ai >= 0) {
    const afterWs = s.slice(ai + anchor.length)
    const slash = afterWs.indexOf('/')
    if (slash >= 0) return afterWs.slice(slash + 1)
  }
  const root = String((row && (row.root_display || row.root)) || '').replace(/\/+$/, '')
  if (root && low.startsWith(`${root.toLowerCase()}/`)) return s.slice(root.length + 1)
  return s
}

// ---------------------------------------------------------------------------
// Wiki-embed loading (![[-image-]] renders real bytes)
// ---------------------------------------------------------------------------

let cachedLocalRoot = null

async function getLocalRoot(ctx) {
  if (cachedLocalRoot != null) return cachedLocalRoot
  try {
    const result = await ctx.rest('/workspaces')
    const rows = Array.isArray(result?.workspaces) ? result.workspaces : []
    const local = rows.find(item => item.id === 'local') || {}
    const root = String(local.root_display || local.root || '').replace(/\/+$/, '')
    cachedLocalRoot = root.startsWith('/') ? root : ''
  } catch {
    cachedLocalRoot = ''
  }
  return cachedLocalRoot
}

function readableBase(workspace) {
  const root = String(workspace?.root_display || workspace?.root || '').replace(/\/+$/, '')
  return root.startsWith('/') ? root : ''
}

function dirnameOf2(p) {
  const idx = String(p || '').lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : ''
}

/** Directory bases to try embed reads against, provider-aware. SSH roots
 *  live on another machine — the gateway only sees them through the
 *  ~/.hermes/remote-workspaces/<id> mount, so the remote path itself is the
 *  LAST resort, not the first. */
async function embedBaseCandidates(ctx, workspaces, workspace) {
  const rows = (workspaces && workspaces.current) || []
  const row = rows.find(item => item.id === workspace.id) || workspace
  const provider = String(row.provider || 'local').toLowerCase()
  const out = []

  if (provider === 'ssh') {
    const localRoot = await getLocalRoot(ctx)

    if (localRoot) out.push(`${localRoot}/remote-workspaces/${row.id}`)
  }

  const direct = readableBase(row)

  if (direct && !out.includes(direct)) out.push(direct)

  return out
}

/** Resolve an embed target to bytes the renderer can display: local shell
 *  first (files on this machine), then the gateway fs (backend machine /
 *  SSH mounts at ~/.hermes/remote-workspaces/<id>). Targets are tried
 *  relative to the current file's directory first, then the workspace root
 *  (Obsidian-style shortest-path), then vault-wide by basename. */

const embedPathCache = new Map()
const embedPathInflight = new Map()
const EMBED_SKIP_DIR = /^(\.trash|\.git|\.obsidian|\.space|node_modules|__pycache__|\.venv)$/i

// Small FIFO pool: a dozen embeds mounting at once must not stampede the
// rclone/gateway listing endpoint, where bursty parallel listings error out.
let listPoolTail = Promise.resolve()
function listGatewayDir(bridge, dirPath) {
  const run = listPoolTail.then(() =>
    bridge.api({ path: `/api/fs/list?path=${encodeURIComponent(dirPath)}` }).then(
      res => (Array.isArray(res?.entries) ? res.entries : []),
      () => []
    )
  )
  listPoolTail = run.catch(() => {})
  // three overlapping windows: tail chains only the last run, so pace by
  // re-chaining onto the run itself for a simple depth-1 throttle
  listPoolTail = listPoolTail.then(() => new Promise(r => setTimeout(r, 15)))
  return run
}

/** Bounded BFS for a file whose basename matches `clean`, scanning each base
 *  subtree (file-dir subtrees are passed first by the caller). Directories
 *  already visited in an earlier pass are skipped, so the workspace-root
 *  pass never rescans the file-dir pass. */
async function findEmbedVaultWide(bridge, bases, relDir, clean) {
  const wanted = clean.toLowerCase()
  const roots = []

  if (relDir) for (const base of bases) roots.push(`${base}/${relDir}`)
  for (const base of bases) roots.push(base)

  const seen = new Set()
  let budget = 600 // directories visited across all passes

  for (const root of roots) {
    const queue = [root]

    while (queue.length && budget-- > 0) {
      const dirEntry = queue.shift()

      if (seen.has(dirEntry)) continue
      seen.add(dirEntry)

      const entries = await listGatewayDir(bridge, dirEntry)

      for (const entry of entries) {
        if (!entry?.name) continue
        const childPath = entry.path || `${dirEntry}/${entry.name}`

        if (entry.isDirectory) {
          if (!EMBED_SKIP_DIR.test(entry.name) && !entry.name.startsWith('.')) queue.push(childPath)
        } else if (entry.name.toLowerCase() === wanted) {
          return childPath
        }
      }
    }
  }

  return null
}

/** Shared per workspace+target resolution: identical embeds mount together,
 *  so they must share one scan, and failures stay retryable. */
function resolveEmbedPath(bridge, workspaceId, rootBases, relDir, clean) {
  const key = `${workspaceId}|${clean.toLowerCase()}`

  if (embedPathCache.has(key)) return Promise.resolve(embedPathCache.get(key))

  const existing = embedPathInflight.get(key)

  if (existing) return existing

  const attempt = findEmbedVaultWide(bridge, rootBases, relDir, clean)
    .then(resolved => {
      if (resolved) {
        if (embedPathCache.size > 200) embedPathCache.clear()
        embedPathCache.set(key, resolved)
      }
      return resolved
    })
    .finally(() => embedPathInflight.delete(key))

  embedPathInflight.set(key, attempt)
  return attempt
}

async function loadEmbedDataUrl(ctx, workspaces, workspace, target, relDir) {
  let base = null

  try {
    const clean = String(target || '').split('#')[0].split('|')[0].replace(/^\/+/, '').trim()
    const bridge = typeof window !== 'undefined' ? window.hermesDesktop : null

    if (!clean || !bridge) return null

    const rootBases = await embedBaseCandidates(ctx, workspaces, workspace)

    if (rootBases.length === 0) return null

    const dir = String(relDir || '').replace(/\/+$/, '')

    const tryRead = async abs => {
      try {
        const direct = await bridge.readFileDataUrl?.(abs)

        if (direct) return direct
      } catch {
        // Not on this machine — fall through to the gateway.
      }

      try {
        const res = await bridge.api({ path: `/api/fs/read-data-url?path=${encodeURIComponent(abs)}` })

        return (typeof res === 'string' ? res : res?.dataUrl) || null
      } catch {
        return null
      }
    }

    for (const candidate of embedCandidatePaths(rootBases, dir, clean)) {
      const url = await tryRead(candidate)

      if (url) return url
    }

    // Obsidian resolves bare filenames vault-wide: `![[Pasted image X.png]]`
    // usually lives in a sibling attachments folder, not next to the note or
    // at the vault root. Bounded recursive basename search — the file's own
    // directory subtree first, then the workspace root. Results are cached
    // per workspace+target so re-renders don't rescan.
    const resolved = await resolveEmbedPath(bridge, workspace.id, rootBases, dir, clean)

    if (resolved) {
      const url = await tryRead(resolved)

      if (url) return url
    }

    return null
  } catch (err) {
    try { window.__heEmbedErr = String((err && err.message) || err).slice(0, 160) } catch {}
    return null
  }
}

async function loadIndexEntries(ctx, workspaceId) {
  const api = editorApi(ctx)
  let result = await api.index(workspaceId)
  if (!Array.isArray(result?.entries)) {
    const built = await ctx.rest(query('/fs/index', { workspace: workspaceId }), { method: 'POST' })
    if (Array.isArray(built?.entries)) {
      await ctx.rest(query('/index/state', { workspace: workspaceId }), { method: 'PUT', body: { entries: built.entries } })
      result = built
    } else {
      result = await api.index(workspaceId)
    }
  }
  return Array.isArray(result?.entries) ? result.entries : []
}

async function loadPageIndex(ctx, workspaceId) {
  return (await loadIndexEntries(ctx, workspaceId))
    .map(entry => String(entry.path || ''))
    .filter(path2 => /\.md$/i.test(path2))
}

// ---------------------------------------------------------------------------
// ZenNotes-pattern GLOBAL note registry: every readable workspace's index
// merged into one list, each entry tagged with its owning workspace id.
// Ctrl+click resolves against THIS — never against whichever index a pane
// happened to load — so existing files always open regardless of where the
// editor is mounted. Light for the Pi: cached 30s, single-flight refresh.
// ---------------------------------------------------------------------------
const noteRegistry = { entries: [], at: 0, inflight: null }

async function buildNoteRegistry(ctx, workspaces) {
  const rows = (workspaces && workspaces.current) || []
  const merged = []
  await Promise.all(rows.map(async row => {
    try {
      for (const entry of await loadIndexEntries(ctx, row.id)) {
        const ep = entry && String(entry.path || '')
        if (ep && /\.md$/i.test(ep) && !ep.split('/').pop().startsWith('._')) merged.push({ ...entry, __ws: row.id })
      }
    } catch { /* one broken workspace must not blind the registry */ }
  }))
  return merged
}

function getNoteRegistry(ctx, workspaces, fresh = false) {
  if (!fresh && noteRegistry.entries.length && Date.now() - noteRegistry.at < 30000) {
    return Promise.resolve(noteRegistry.entries)
  }
  if (noteRegistry.inflight) return noteRegistry.inflight
  noteRegistry.inflight = buildNoteRegistry(ctx, workspaces).then(entries => {
    if (entries.length || !noteRegistry.entries.length) noteRegistry.entries = entries
    noteRegistry.at = Date.now()
    noteRegistry.inflight = null
    return noteRegistry.entries
  }).catch(() => {
    noteRegistry.inflight = null
    return noteRegistry.entries
  })
  return noteRegistry.inflight
}


function DesktopEditor({ ctx, sync, target, workspace, workspaces, onDirtyChange }) {
  const basePath = target.workspace?.relativePath || workspaceRelPath(workspace, fileName(target))
  const [navPath, setNavPath] = useState(null)
  const hostRef = useRef(null)
  const editor = useRef(null)
  const md = useRef(null)
  const file = useRef(null)
  const pagesRef = useRef([])
  const knownRef = useRef(new Set())
  const [state, setState] = useState({ error: '', loading: true, conflict: null, dirty: false })
  const [health, setHealth] = useState(null)
  const [copied, setCopied] = useState(false)
  const prevOnline = useRef(null)
  const navWsRef = useRef(null)
  // Heading anchor to reveal once the next editor finishes mounting
  // ([[Note#Heading]] navigation), plus raw index entries for suggestions.
  const pendingAnchorRef = useRef(target.workspace?.anchor || null)
  const entriesRef = useRef([])
  const path = navPath || basePath
  // A Ctrl+clicked note may belong to a different workspace than this pane
  // was mounted with; all I/O for the open path must address ITS owner.
  const wsId = navWsRef.current && navPath ? navWsRef.current : workspace.id
  // Vault-relative view of the open file (mount anchors stripped).
  const wsRow = (((workspaces && workspaces.current) || []).find(item => item.id === wsId)) || workspace
  const relNotePath = workspaceRelPath(wsRow, path)
  const api = editorApi(ctx)

  // A repeated host.openWorkspace call fronts the existing tab and refreshes
  // its render callback. Keep anchor navigation in the component so following
  // a link to an already-open note does not reload its (possibly dirty) buffer.
  useEffect(() => {
    const anchor = target.workspace?.anchor
    if (!anchor) return
    pendingAnchorRef.current = anchor
    if (md.current?.revealHeading) {
      try {
        md.current.revealHeading(anchor)
        pendingAnchorRef.current = null
      } catch { /* the editor may still be mounting */ }
    }
  }, [target.workspace?.anchor])

  useEffect(() => { onDirtyChange?.(!!state.dirty) }, [onDirtyChange, state.dirty])

  useEffect(() => {
    let dead = false
    prevOnline.current = null
    const check = () => {
      api.health(workspace.id).then(h => {
        if (dead) return
        setHealth(h)
        const online = h?.online !== false
        if (prevOnline.current === true && !online) {
          sdkHost.notifyError(new Error('host=' + (workspace.host || 'backend') + ' endpoints=' + JSON.stringify(h?.endpoints || {})), 'Workspace offline \u2014 changes can\u2019t be saved')
        }
        prevOnline.current = online
      }).catch(() => {
        if (dead) return
        setHealth({ online: false, endpoint: null })
        if (prevOnline.current === true) {
          sdkHost.notifyError(new Error('health check failed'), 'Workspace offline \u2014 changes can\u2019t be saved')
        }
        prevOnline.current = false
      })
    }
    check()
    const timer = setInterval(check, 30000)
    return () => { dead = true; clearInterval(timer) }
  }, [workspace.id])

  const offline = health ? health.online === false : false

  const copyLog = async () => {
    const extra = []
    if (state.error) extra.push('last_error: ' + state.error)
    if (state.conflict) extra.push('conflict: ' + state.conflict)
    if (state.dirty) extra.push('dirty: local edits not saved')
    const ok = await copyDiagnosticsToClipboard(workspaceDiagnostics(workspace, health, extra))
    setCopied(ok)
    setTimeout(() => setCopied(false), 2000)
  }

  const save = async force => {
    if (!file.current) return
    const content = isMarkdown(path)
      ? globalThis.__HERMES_EDITOR_MD__.serializeMarkdown(md.current.toJSON()).markdown
      : editor.current.getValue()
    try {
      const result = await api.put({ workspace: wsId }, { path, content, base_revision: force ? '' : file.current.revision, force: !!force })
      file.current = result
      sync.noteWritten(wsId, path, result.revision)
      md.current?.markClean()
      setState({ error: '', loading: false, conflict: null, dirty: false })
    } catch (error) {
      if (error?.status === 409 || error?.message?.includes('409')) setState(value => ({ ...value, conflict: 'File changed on disk. Reload discards local edits; overwrite requires confirmation.' }))
      else setState(value => ({ ...value, error: String(error?.message || error) }))
    }
  }

  /** Last-resort note lookup through this plugin's workspace file API. */
  async function findNoteOnDisk(wanted, relDir) {
    const rows = (workspaces && workspaces.current) || []
    for (const row of rows) {
      const queue = [...new Set([relDir, ''])]
      const seen = new Set()
      let budget = 120
      while (queue.length && budget-- > 0) {
        const dir = queue.shift()
        if (seen.has(dir)) continue
        seen.add(dir)
        let entries = []
        try {
          const res = await ctx.rest(query('/fs/tree', { path: dir, workspace: row.id }))
          entries = Array.isArray(res?.entries) ? res.entries : []
        } catch { entries = [] }
        for (const entry of entries) {
          if (!entry?.name) continue
          const childPath = entry.path || (dir ? `${dir}/${entry.name}` : entry.name)
          if (entry.type === 'dir' || entry.isDirectory || entry.is_dir) {
            if (!EMBED_SKIP_DIR.test(entry.name) && !entry.name.startsWith('.')) queue.push(childPath)
          } else if (/\.md$/i.test(entry.name) && !entry.name.startsWith('._')) {
            if (normNote(childPath) === wanted || normNote(entry.name) === wanted) {
              return { rel: childPath, wsId: row.id }
            }
          }
        }
      }
    }
    return null
  }

  /** Which workspace id should own I/O for `p` — a clicked note may live in a
   *  different workspace than the pane that opened it. */
  function owningWorkspaceId(p) {
    if (!navWsRef.current || p !== navPath) return workspace.id
    return navWsRef.current
  }

  /** Open another note in a supported host workspace tab. Keeping navigation
   * in the host means every tab retains its own title and close button. */
  const openNoteInTab = (nextPath, nextWorkspaceId, anchor = null) => {
    const workspaceId = nextWorkspaceId || workspace.id
    const nextWorkspace = (workspaces.current || []).find(item => item.id === workspaceId) || workspace
    openEditorWorkspace(ctx, sync, workspaces, nextWorkspace, nextPath, anchor)
  }

  /** Dead-link rescue: offer to create the missing note next to the current
   *  file, then open it. Mirrors ZenNotes' offer-create flow. */
  const createNoteFromLink = async raw => {
    const clean = String(raw || '').split('|')[0].split('#')[0].replace(/[[\]]/g, '').trim()
    const safe = (clean.split('/').pop() || '').replace(/[\\:*?"<>|]/g, '-').trim().replace(/\.md$/i, '')
    if (!safe) return false
    if (!window.confirm(`Note "${safe}" not found. Create it?`)) return false
    try {
      // The index may have changed while the confirmation dialog was open.
      // Re-check immediately before writing so an existing note is never
      // overwritten or duplicated by the dead-link rescue path.
      const entries = await getNoteRegistry(ctx, workspaces, true)
      entriesRef.current = entries
      const existing = findEntryByRef(entries, clean)
      if (existing && String(existing.path || '')) {
        openNoteInTab(String(existing.path), existing.__ws || workspace.id)
        return true
      }
      const dir = dirnameOf2(relNotePath)
      const newPath = `${dir ? `${dir}/` : ''}${safe}.md`
      try {
        await api.get({ workspace: wsId, path: newPath })
        openNoteInTab(newPath, wsId)
        return true
      } catch { /* genuinely absent: create below */ }
      await api.put({ workspace: wsId }, { path: newPath, content: `# ${safe}\n\n`, base_revision: '', force: false })
      openNoteInTab(newPath, wsId)
      return true
    } catch (err) {
      sdkHost.notifyError(err, 'Create failed')
      return false
    }
  }

  /** Headings for the [[Note# suggestion phase: the target note's indexed
   *  headings, or — for same-file [[# — this document's live headings. */
  function headingsFor(target) {
    const wanted = normNote(target)
    if (!wanted) {
      try { return (md.current?.headings?.() || []).slice(0, 8) } catch { return [] }
    }
    const hit = entriesRef.current.find(entry =>
      normNote(String(entry.path || '')) === wanted ||
      normNote(basename(String(entry.path || ''))) === wanted ||
      normNote(String(entry.title || '')) === wanted ||
      (Array.isArray(entry.aliases) && entry.aliases.some(alias => normNote(String(alias)) === wanted)))
    return ((hit && Array.isArray(hit.headings)) ? hit.headings : [])
      .map(heading => String(heading.text || '')).filter(Boolean).slice(0, 8)
  }

  const openNote = async (raw, anchor) => {
    try {
      // Same-file heading link ([[#Heading]]): no target to look up — scroll
      // the currently mounted document instead.
      const wanted = normNote(raw)
      if (!wanted) {
        if (anchor && md.current?.revealHeading) md.current.revealHeading(anchor)
        return
      }
      const log = (window.__heOpenLog = window.__heOpenLog || [])
      // Standard markdown links resolve RELATIVE TO THE NOTE containing them
      // (ZenNotes internal-links mode): [x](../Math/Matrices.md).
      const rel = resolveRelativeHref(relNotePath, String(raw))
      const relWanted = rel && rel.target ? normNote(rel.target) : ''
      const navAnchor = anchor || (rel && rel.fragment) || null

      // ZenNotes resolution ladder over ONE global registry spanning every
      // readable workspace: exact path -> unique suffix -> unique basename ->
      // title -> alias. Pane binding and index load order can't cause misses.
      let registry = await getNoteRegistry(ctx, workspaces)
      let hit = findEntryByRef(registry, wanted, dirnameOf2(relNotePath))
      if (!hit && relWanted && relWanted !== wanted) hit = findEntryByRef(registry, relWanted, dirnameOf2(relNotePath))
      log.push({ ev: 'registry', wanted, relWanted, found: hit && hit.path, ws: hit && hit.__ws, size: registry.length })

      if (!hit) {
        // Registry gap safety net: bounded basename scan across every base.
        const disk = await findNoteOnDisk(relWanted || wanted, dirnameOf2(relNotePath))
        if (disk) hit = { path: disk.rel, __ws: disk.wsId }
        log.push({ ev: 'diskFallback', found: hit && hit.path })
      }

      if (!hit) {
        // Stale registry: force one refresh and retry the ladder once.
        registry = await getNoteRegistry(ctx, workspaces, true)
        hit = findEntryByRef(registry, wanted, dirnameOf2(relNotePath))
        if (!hit && relWanted && relWanted !== wanted) hit = findEntryByRef(registry, relWanted, dirnameOf2(relNotePath))
        log.push({ ev: 'refresh', found: hit && hit.path, ws: hit && hit.__ws })
      }

      if (hit) {
        openNoteInTab(String(hit.path), hit.__ws || workspace.id, navAnchor)
        return
      }

      // ZenNotes-style dead-link rescue — but only for note-like targets.
      // Asset references (images/PDFs/media) are never offered creation.
      if (/\.(png|jpe?g|gif|webp|svg|avif|bmp|pdf|m4a|mp3|mp4|mov|wav|zip)$/i.test(String(raw || ''))) {
        sdkHost.notifyError(new Error(`File not found: ${raw}`), 'Open failed')
        return
      }
      const created = await createNoteFromLink(raw)
      if (!created) sdkHost.notifyError(new Error(`Note not found: ${raw}`), 'Open failed')
    } catch (error) {
      sdkHost.notifyError(error, 'Open failed')
    }
  }

  useEffect(() => {
    let cancelled = false
    let unsubscribe = () => {}
    let removeInternalFileLinkHandler = () => {}
    let clearTabReveal = () => {}
    Promise.all([
      api.get({ workspace: wsId, path }),
      loadIndexEntries(ctx, wsId).catch(() => []),
      getNoteRegistry(ctx, workspaces).catch(() => [])
    ]).then(([result, entries]) => {
      if (cancelled) return
      entriesRef.current = entries
      const paths = entries.map(entry => String(entry.path || '')).filter(path2 => /\.md$/i.test(path2))
      pagesRef.current = paths.map(path2 => path2.replace(/\.md$/i, ''))
      knownRef.current = new Set(paths.map(path2 => normNote(path2)))
      file.current = result
      unsubscribe = sync.subscribe(wsId, path, result.revision, event => {
        if (event.type === 'file.changed' || event.type === 'file.deleted') setState(value => ({ ...value, conflict: value.dirty ? 'File changed on disk while local edits are dirty.' : 'File changed on disk. Reload to refresh.' }))
      })
      setState({ error: '', loading: false, conflict: null, dirty: false })
      if (isMarkdown(path)) {
        const core = globalThis.__HERMES_EDITOR_MD__
        const ui = globalThis.__HERMES_EDITOR_UI__
        md.current = ui.createMdEditor(hostRef.current, {
          docJSON: core.parseMarkdown(result.content || ''),
          onChange: () => setState(value => ({ ...value, dirty: md.current?.isDirty() || false })),
          openExternal: url => ctx.os.openExternal(url),
          openInternal: href => void openNote(href),
          openWiki: attrs => void openNote(attrs.target, attrs.heading),
          loadEmbed: embedTarget => loadWorkspaceImage(ctx, wsRow, embedTarget, relNotePath),
          resolveWiki: value => {
            const wanted = normNote(value)
            if (knownRef.current.has(wanted) || pagesRef.current.some(item => normNote(basename(item)) === wanted)) return true
            if (findEntryByRef(entriesRef.current, wanted)) return true
            return !!findEntryByRef(noteRegistry.entries, wanted)
          },
          suggestHeadings: target => headingsFor(target),
          suggestPages: q => rankPages(pagesRef.current, q)
        })
        // EditorView defaults to editable, but set the prop at the Desktop
        // boundary so a future shared renderer change cannot make this tab a
        // read-only preview. This alone does not restore pointer selection:
        // the host can apply user-select:none to the tab tree, which the
        // scoped editor.css rule overrides.
        md.current.view.setProps({ editable: () => true })
        const revealAnchor = anchor => {
          if (!anchor || !md.current?.revealHeading) return false
          try {
            md.current.revealHeading(anchor)
            return true
          } catch { return false }
        }
        const tab = workspaces.tabs?.get(`hermes-editor:file:${encodeURIComponent(wsId)}:${encodeURIComponent(basePath)}`)
        if (tab) {
          tab.revealAnchor = revealAnchor
          clearTabReveal = () => { if (tab.revealAnchor === revealAnchor) tab.revealAnchor = null }
        }
        const onInternalFileLink = event => {
          if (event.button !== 0 || event.altKey || event.shiftKey) return
          const link = event.target?.closest?.('a[data-extlink][href]')
          if (!link || !hostRef.current?.contains(link)) return
          const href = link.getAttribute('href') || ''
          const resolved = resolveRelativeHref(relNotePath, href)
          // External URLs, protocol-relative URLs, and in-page anchors remain
          // under the renderer/browser's existing behavior.
          if (!resolved?.target) return

          event.preventDefault()
          event.stopPropagation()
          // Non-Markdown files open directly in an editor tab. Markdown links
          // go through the note registry so titles, aliases, and workspace
          // ownership keep the same resolution rules as wiki-links.
          if (!/\.md$/i.test(href) && isSupported(editorTarget(wsRow, resolved.target))) {
            openNoteInTab(resolved.target, wsId, resolved.fragment)
          } else {
            void openNote(href)
          }
        }
        // The renderer deliberately reserves Ctrl/Cmd-click for navigation
        // and treats an ordinary link click as a caret placement. Desktop
        // file links should navigate on click, so handle them in capture phase
        // before ProseMirror's click handler while preserving text editing
        // everywhere else.
        hostRef.current.addEventListener('click', onInternalFileLink, true)
        removeInternalFileLinkHandler = () => hostRef.current?.removeEventListener('click', onInternalFileLink, true)
        // [[Note#Heading]] navigation: reveal the anchor once mounted.
        if (pendingAnchorRef.current) {
          const anchorText = pendingAnchorRef.current
          pendingAnchorRef.current = null
          revealAnchor(anchorText)
        }
      } else {
        editor.current = monaco.editor.create(hostRef.current, {
          automaticLayout: true,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 13,
          language: languageFor(path),
          minimap: { enabled: false },
          padding: { top: 12, bottom: 12 },
          readOnly: false,
          smoothScrolling: true,
          theme: 'hermes',
          value: result.content || ''
        })
        editor.current.onDidChangeModelContent(() => setState(value => ({ ...value, dirty: true })))
        editor.current.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save(false))
      }
    }).catch(error => !cancelled && setState({ error: String(error?.message || error), loading: false, conflict: null, dirty: false }))
    return () => {
      cancelled = true
      unsubscribe()
      removeInternalFileLinkHandler()
      clearTabReveal()
      md.current?.destroy(); md.current = null
      editor.current?.dispose(); editor.current = null
    }
  }, [path, sync, workspace.id])

  useEffect(() => {
    const onKeyDown = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(false) }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  })

  return React.createElement('div', { className: 'he-desktop-editor' },
    offline && React.createElement('div', { className: 'he-offline-banner' },
      React.createElement('div', { className: 'he-offline-text' },
        React.createElement('strong', null, 'Workspace offline'),
        ' \u2014 changes can\u2019t be saved right now. ' + (workspace.host ? 'Device \u201c' + workspace.host + '\u201d is unreachable.' : 'Backend unreachable.')),
      React.createElement('button', { type: 'button', className: 'he-copylog', onClick: () => void copyLog() },
        copied ? 'Copied \u2713' : 'Copy error log')),
    React.createElement('header', null, React.createElement('span', null, navPath ? basename(path) : target.label), state.dirty && React.createElement('span', null, ' *'), React.createElement('button', { onClick: () => void save(false), type: 'button' }, 'Save')),
    state.conflict && React.createElement('div', { className: 'he-desktop-conflict' }, state.conflict, React.createElement('button', { onClick: () => window.confirm('Overwrite disk content with local edits?') && void save(true), type: 'button' }, 'Overwrite')),
    state.error && React.createElement('div', { className: 'he-desktop-error' },
      state.error,
      React.createElement('button', { type: 'button', className: 'he-copylog', onClick: () => void copyLog() },
        copied ? 'Copied \u2713' : 'Copy error log')),
    state.loading && React.createElement('div', null, 'Loading editor...'),
    React.createElement('div', { className: 'he-desktop-editor-host', ref: hostRef }))
}

function editorTarget(workspace, path, anchor = null) {
  const relativePath = workspaceRelPath(workspace, path)
  return {
    kind: 'file',
    label: basename(relativePath),
    path: relativePath,
    source: relativePath,
    workspace: {
      anchor: anchor || undefined,
      relativePath,
      workspaceId: workspace.id
    }
  }
}

/** The public Desktop SDK replacement for the retired preview renderer.
 * Re-opening a workspace id focuses and refreshes the existing main-area tab. */
function openEditorWorkspace(ctx, sync, workspaces, workspace, path, anchor = null) {
  if (!workspace || !workspace.id) {
    sdkHost.notifyError(new Error('The selected file is not in a configured workspace.'), 'Open failed')
    return false
  }
  const target = editorTarget(workspace, path, anchor)
  if (!isSupported(target)) {
    sdkHost.notifyError(new Error(`Unsupported file type: ${target.path}`), 'Open failed')
    return false
  }
  if (typeof sdkHost.openWorkspace !== 'function') {
    sdkHost.notifyError(new Error('Hermes Desktop needs a version with host.openWorkspace.'), 'Open failed')
    return false
  }
  const tabId = `hermes-editor:file:${encodeURIComponent(workspace.id)}:${encodeURIComponent(target.path)}`
  let tab = workspaces.tabs?.get(tabId)
  const isNewTab = !tab
  if (!tab) {
    tab = { workspaceId: workspace.id, path: target.path, dirty: false, close: null, revealAnchor: null }
    tab.render = () => React.createElement(DesktopEditor, {
      ctx, sync, target: tab.target, workspace: tab.workspace, workspaces,
      onDirtyChange: dirty => { tab.dirty = dirty }
    })
    tab.onClose = () => {
      tab.revealAnchor = null
      if (workspaces.tabs?.get(tabId) === tab) workspaces.tabs.delete(tabId)
    }
  }
  tab.target = target
  tab.workspace = workspace
  tab.path = target.path
  // If the destination is already open, reveal its heading in the live model
  // before asking the public host API to bring that tab to the front.
  if (anchor) {
    tab.revealAnchor?.(anchor)
  }
  const close = sdkHost.openWorkspace(tabId, {
    title: target.label,
    minWidth: '32rem',
    onClose: tab.onClose,
    render: tab.render
  })
  tab.close = close
  workspaces.tabs?.set(tabId, tab)
  // host.openWorkspace is not a ctx.register contribution, so explicitly
  // retire each tab this plugin opened when it is reloaded or disabled. The
  // closure reads tab.close so a later same-ID focus refresh is also disposed.
  if (isNewTab) ctx.onDispose(() => tab.close?.())
  return true
}

function affectedEditorTabs(workspaces, workspace, path, isDirectory) {
  const prefix = `${path}/`
  return [...(workspaces.tabs?.values() || [])].filter(tab =>
    tab.workspaceId === workspace.id && (tab.path === path || (isDirectory && tab.path.startsWith(prefix))))
}

/** Choose a backend-local workspace file through the public, attributed OS
 * picker. The plugin deliberately refuses paths outside a configured workspace:
 * the backend file API is workspace-addressed and must stay that way. */
async function pickEditorFile(ctx, sync, workspaces, preferredWorkspace = null) {
  const picked = await ctx.os.pickOpenPath({
    defaultPath: preferredWorkspace ? readableBase(preferredWorkspace) : undefined,
    filters: [{ name: 'Editable files', extensions: ['md', 'txt', 'js', 'jsx', 'ts', 'tsx', 'json', 'yaml', 'yml', 'py', 'rb', 'rs', 'go', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'sh', 'sql', 'ini'] }],
    title: 'Open file in Hermes Editor'
  })
  if (!picked) return false
  const workspace = workspaceForPreviewPath(workspaces.current, picked)
  if (!workspace) {
    sdkHost.notifyError(new Error('Choose a file inside a configured Hermes Editor workspace.'), 'Open failed')
    return false
  }
  return openEditorWorkspace(ctx, sync, workspaces, workspace, picked)
}

function treeEntry(entry) {
  const relativePath = String(entry?.path || entry?.relative_path || entry?.name || '').replace(/^[/\\]+/, '')
  return {
    isDirectory: Boolean(entry?.isDirectory || entry?.is_dir || entry?.type === 'directory' || entry?.type === 'dir'),
    name: String(entry?.name || relativePath.split('/').pop() || relativePath),
    relativePath
  }
}

function createFileWorkspaceProvider(ctx) {
  return {
    async readDirectory(workspace, relativePath) {
      const result = await ctx.rest(`/fs/tree?${new URLSearchParams({ path: relativePath, workspace: workspace.id })}`)
      return { entries: Array.isArray(result?.entries) ? result.entries.map(treeEntry) : [] }
    },
    async createFile(workspace, relativePath, content = '') {
      return ctx.rest(query('/fs/file', { workspace: workspace.id }), {
        method: 'PUT', body: { path: relativePath, content, base_revision: '', force: false }
      })
    },
    async createFolder(workspace, relativePath) {
      return ctx.rest(query('/fs/mkdir', { workspace: workspace.id }), { method: 'POST', body: { path: relativePath } })
    },
    async rename(workspace, relativePath, name) {
      const parent = relativePath.lastIndexOf('/')
      const to = parent < 0 ? name : `${relativePath.slice(0, parent + 1)}${name}`
      return ctx.rest(query('/fs/move', { workspace: workspace.id }), {
        method: 'POST', body: { from: relativePath, to }
      })
    },
    async remove(workspace, relativePath) {
      return ctx.rest(query('/fs/delete', { workspace: workspace.id }), { method: 'POST', body: { path: relativePath } })
    }
  }
}

function slugifyWorkspaceId(value, taken) {
  const base = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'ws'
  let id = base
  let n = 2
  while (taken.has(id)) { id = `${base}-${n}`; n += 1 }
  return id
}

function AddWorkspaceDialog({ ctx, rows, onClose, onAdded }) {
  const NEW_HOST = '__new_ssh_host__'
  const [hosts, setHosts] = useState([])
  const [host, setHost] = useState('')
  const [newHostId, setNewHostId] = useState('')
  const [newHostUser, setNewHostUser] = useState('')
  const [newHostEndpoints, setNewHostEndpoints] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [alsoProject, setAlsoProject] = useState(true)

  useEffect(() => {
    let dead = false
    ctx.rest('/hosts').then(result => {
      if (!dead) setHosts(Array.isArray(result?.hosts) ? result.hosts : [])
    }).catch(() => {})
    return () => { dead = true }
  }, [ctx])

  const submit = async () => {
    const trimmed = rootPath.trim()
    if (!trimmed.startsWith('/')) { setError('Root must be an absolute path starting with /'); return }
    setBusy(true)
    setError('')
    try {
      let selectedHost = host
      if (host === NEW_HOST) {
        const id = newHostId.trim().toLowerCase()
        const endpoints = newHostEndpoints.split(/[\s,]+/).map(value => value.trim()).filter(Boolean)
        if (!id || !newHostUser.trim() || endpoints.length === 0) {
          throw new Error('New SSH machine needs an ID, user, and at least one endpoint')
        }
        await ctx.rest('/hosts', { method: 'POST', body: { id, user: newHostUser.trim(), endpoints } })
        selectedHost = id
      }
      const name = label.trim() || trimmed.split('/').filter(Boolean).pop() || 'workspace'
      const id = slugifyWorkspaceId(name, new Set(rows.map(item => item.id)))
      const created = {
        id,
        label: name,
        provider: selectedHost ? 'ssh' : 'local',
        host: selectedHost || null,
        root: trimmed.replace(/\/+$/, '') || '/'
      }
      await ctx.rest('/workspaces', { method: 'POST', body: created })
      if (alsoProject) {
        const project = await ensureProjectForWorkspace(ctx, rows, created)
        if (project?.id) refreshSidebarProjects()
      }
      onAdded()
    } catch (err) {
      setError(String(err?.message || err))
      setBusy(false)
    }
  }

  return React.createElement('div', {
    className: 'he-ws-overlay',
    onMouseDown: event => { if (event.target === event.currentTarget && !busy) onClose() }
  },
    React.createElement('div', { className: 'he-ws-dialog' },
      React.createElement('h3', null, 'Add workspace'),
      React.createElement('label', null, 'Host'),
      React.createElement('select', { value: host, onChange: event => setHost(event.currentTarget.value) },
        React.createElement('option', { value: '' }, 'Backend machine (local)'),
        hosts.map(h => React.createElement('option', { key: h, value: h }, `SSH: ${h}`)),
        React.createElement('option', { value: NEW_HOST }, 'Add SSH machine…')),
      host === NEW_HOST && React.createElement(React.Fragment, null,
        React.createElement('label', null, 'Machine ID'),
        React.createElement('input', { placeholder: 'e.g. studio-pc', value: newHostId, onChange: event => setNewHostId(event.currentTarget.value) }),
        React.createElement('label', null, 'SSH user'),
        React.createElement('input', { placeholder: 'e.g. alex', value: newHostUser, onChange: event => setNewHostUser(event.currentTarget.value) }),
        React.createElement('label', null, 'Endpoints'),
        React.createElement('input', { placeholder: 'hostname, LAN IP, or Tailscale IP', value: newHostEndpoints, onChange: event => setNewHostEndpoints(event.currentTarget.value) })),
      React.createElement('label', null, 'Root directory'),
      React.createElement('input', {
        placeholder: '/absolute/path/on/host',
        value: rootPath,
        onChange: event => setRootPath(event.currentTarget.value)
      }),
      React.createElement('label', null, 'Label'),
      React.createElement('input', {
        placeholder: 'Optional - defaults to folder name',
        value: label,
        onChange: event => setLabel(event.currentTarget.value)
      }),
      error && React.createElement('div', { className: 'he-ws-error' }, error),
      React.createElement('label', { className: 'he-ws-also' },
        React.createElement('input', {
          type: 'checkbox',
          checked: alsoProject,
          onChange: event => setAlsoProject(event.currentTarget.checked)
        }),
        'Also add to Projects'),
      React.createElement('div', { className: 'he-ws-actions' },
        React.createElement('button', { type: 'button', disabled: busy, onClick: onClose }, 'Cancel'),
        React.createElement('button', { type: 'button', className: 'primary', disabled: busy, onClick: () => void submit() }, busy ? 'Adding…' : 'Add workspace'))))
}

const HOST_SDK = () => globalThis.__HERMES_PLUGIN_SDK__ || {}
const HOST_RPC = () => HOST_SDK().host || null
const refreshSidebarProjects = () => {
  const refresh = HOST_SDK().refreshProjectTree
  if (typeof refresh === 'function') { try { void refresh() } catch {} }
}

function workspaceDiagnostics(workspace, health, extraLines) {
  const lines = []
  lines.push('Hermes editor - workspace diagnostics')
  lines.push('time: ' + new Date().toISOString())
  lines.push('workspace: ' + (workspace?.id || '?') + ' (' + (workspace?.label || '') + ')')
  lines.push('provider: ' + (workspace?.provider || '?') + (workspace?.host ? ' host=' + workspace.host : ''))
  lines.push('root: ' + (workspace?.root_display || workspace?.root || 'hermes home'))
  if (health) {
    lines.push('online: ' + (health.online === false ? 'NO' : 'yes'))
    if (health.endpoint) lines.push('endpoint: ' + health.endpoint)
    if (health.hostname) lines.push('hostname: ' + health.hostname)
    if (typeof health.latency_ms === 'number') lines.push('latency_ms: ' + health.latency_ms)
    for (const [ep, st] of Object.entries(health.endpoints || {})) {
      lines.push('endpoint ' + ep + ': ' + (st.cooling ? 'cooling ' + st.cooldown_remaining_s + 's' : 'ok') + ', consecutive_failures=' + (st.consecutive_failures || 0))
    }
  }
  for (const line of extraLines || []) if (line) lines.push(line)
  return lines.join('\n')
}

async function copyDiagnosticsToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true } catch {}
  try {
    if (window.hermesDesktop && typeof window.hermesDesktop.writeClipboard === 'function') {
      await window.hermesDesktop.writeClipboard(text)
      return true
    }
  } catch {}
  return false
}

function ensureProjectForWorkspace(ctx, rows, workspace) {
  const host = HOST_RPC()
  if (!host || typeof host.request !== 'function' || !workspace) return Promise.resolve(null)
  const label = workspace.label || workspace.id
  let folderPromise
  if (workspace.provider === 'local') {
    folderPromise = Promise.resolve(workspaceProjectRoot(rows, workspace))
  } else {
    const root = workspaceProjectRoot(rows, workspace)
    if (!root) return Promise.resolve(null)
    folderPromise = ctx.rest(`/workspaces/${encodeURIComponent(workspace.id)}/mount`, { method: 'POST' })
      .catch(err => {
        sdkHost.notifyError(err, 'Mount failed — agent will not see these files')
        return null
      })
      .then(() => root)
  }
  return folderPromise.then(folder => {
    const root = String(folder || '').replace(/\/+$/, '')
    if (!root.startsWith('/')) return null
    return host.request('projects.list', {}).then(result => {
      const projects = Array.isArray(result?.projects) ? result.projects : []
      const hit = projects.find(project => (project.folders || []).some(entry => String(entry.path || entry).replace(/\/+$/, '') === root)) ||
        projects.find(project => project.primary_path && String(project.primary_path).replace(/\/+$/, '') === root)
      if (hit) return hit
      return host.request('projects.create', { name: label, folders: [root] }).then(created => created?.project || null)
    })
  }).catch(() => null)
}

function loadWorkspaceChats(ws) {
  const host = HOST_RPC()
  if (!host || typeof host.request !== 'function' || !ws) return Promise.resolve([])
  const root = String(ws.root_display || ws.root || '').replace(/\/+$/, '')
  if (ws.provider !== 'local' || !root.startsWith('/')) return Promise.resolve([])
  return host.request('projects.tree', { preview_limit: 8 }).then(result => {
    const projects = Array.isArray(result?.projects) ? result.projects : []
    const match = projects.find(project => {
      if (project.path && String(project.path).replace(/\/+$/, '') === root) return true
      return (project.repos || []).some(repo => repo.path && String(repo.path).replace(/\/+$/, '').startsWith(root))
    })
    if (!match) return []
    const rows = []
    for (const repo of match.repos || []) {
      for (const group of repo.groups || []) {
        for (const session of group.sessions || []) {
          rows.push({ id: session.id || session.session_id, title: session.title || session.name || session.id, lane: group.label || repo.label })
        }
      }
      for (const preview of repo.previewSessions || []) {
        if (preview && !rows.some(row => row.id === (preview.id || preview.session_id))) {
          rows.push({ id: preview.id || preview.session_id, title: preview.title || preview.name || preview.id, lane: repo.label })
        }
      }
    }
    return rows.filter(row => row.id)
  }).catch(() => [])
}

function WorkspacesPane({ ctx, workspaces, onOpenFile, onOpenExplorerFile, onBeforePathMutation, onPathRemoved, onPathMoved }) {
  const EMPTY = '__none__'
  const [rows, setRows] = useState(workspaces.current)
  const [selected, setSelected] = useState('')
  const [workspaceLoadError, setWorkspaceLoadError] = useState('')
  const [adding, setAdding] = useState(false)
  const [manage, setManage] = useState(false)
  const [chats, setChats] = useState([])
  const [chatsFor, setChatsFor] = useState(null)
  const [chatStarting, setChatStarting] = useState(false)
  const [projectLinks, setProjectLinks] = useState({})
  const [linking, setLinking] = useState(false)

  const localRoot = String((rows.find(item => item.id === 'local') || {}).root_display || '').replace(/\/+$/, '')

  const workspaceFolder = ws => {
    if (!ws) return null
    if (ws.provider === 'local') {
      const root = String(ws.root_display || ws.root || '').replace(/\/+$/, '')
      return root.startsWith('/') ? root : null
    }
    return localRoot.startsWith('/') ? `${localRoot}/remote-workspaces/${ws.id}` : null
  }

  const loadProjectLinks = useCallback(() => {
    const host = HOST_RPC()
    if (!host || typeof host.request !== 'function') return
    host.request('projects.tree', { preview_limit: 1 }).then(result => {
      const map = {}
      for (const project of result?.projects || []) {
        const paths = new Set()
        if (project.path) paths.add(String(project.path).replace(/\/+$/, ''))
        for (const repo of project.repos || []) {
          if (repo?.path) paths.add(String(repo.path).replace(/\/+$/, ''))
        }
        for (const path of paths) map[path] = project.id
      }
      setProjectLinks(map)
    }).catch(() => {})
  }, [])

  useEffect(() => { loadProjectLinks() }, [loadProjectLinks])

  const addToProjects = async () => {
    if (!active || linking) return
    setLinking(true)
    try {
      const project = await ensureProjectForWorkspace(ctx, rows, active)
      if (project?.id) { loadProjectLinks(); refreshSidebarProjects() }
      else sdkHost.notifyError(new Error('Project link failed'), 'Add to Projects')
    } catch (error) {
      sdkHost.notifyError(error, 'Add to Projects')
    } finally {
      setLinking(false)
    }
  }

  const refreshRows = useCallback((includeDisabled = manage) => {
    ctx.rest(`/workspaces${includeDisabled ? '?include_disabled=true' : ''}`).then(result => {
      const next = Array.isArray(result?.workspaces) ? result.workspaces : []
      workspaces.current = next
      setRows(next)
      setWorkspaceLoadError('')
      setSelected(current => {
        if (next.some(row => row.id === current && row.enabled !== false)) return current
        const saved = ctx.storage.get('selectedWorkspace', '')
        return next.some(row => row.id === saved && row.enabled !== false) ? saved : ''
      })
    }).catch(error => {
      setWorkspaceLoadError(String(error?.message || error))
    })
  }, [ctx, manage, workspaces])

  useEffect(() => { refreshRows() }, [refreshRows])

  useEffect(() => {
    const timer = setInterval(refreshRows, 60000)
    return () => clearInterval(timer)
  }, [refreshRows])

  const copyPaneLog = async () => {
    let health = null
    try { health = await ctx.rest('/workspaces/' + encodeURIComponent(active.id) + '/health') } catch (err) { health = { online: false } }
    const ok = await copyDiagnosticsToClipboard(workspaceDiagnostics(active, health, [active.online === false ? 'registry_status: offline' : '']))
    if (!ok) sdkHost.notifyError(new Error('Clipboard unavailable'), 'Copy failed')
  }

  const active = rows.find(item => item.id === selected) || null

  useEffect(() => {
    let dead = false
    setChats([]); setChatsFor(null)
    if (!active || active.provider !== 'local') return undefined
    const root = String(active.root_display || active.root || '').replace(/\/+$/, '')
    if (!root.startsWith('/')) return undefined
    const hostRpc = HOST_RPC()
    if (!hostRpc || typeof hostRpc.request !== 'function') return undefined
    hostRpc.request('projects.tree', { preview_limit: 8 }).then(result => {
      if (dead) return null
      const projects = Array.isArray(result?.projects) ? result.projects : []
      let match = projects.find(project => {
        if (project.path && String(project.path).replace(/\/+$/, '') === root) return true
        return (project.repos || []).some(repo => repo.path && String(repo.path).replace(/\/+$/, '').startsWith(root))
      }) || null
      if (!match) return []
      return hostRpc.request('projects.project_sessions', { project_id: match.id }).then(hydrated => {
        if (dead) return []
        const repos = hydrated?.project?.repos || match.repos || []
        const rowsOut = []
        for (const repo of repos) {
          for (const group of repo.groups || []) {
            for (const session of group.sessions || []) {
              const id = session.id || session.session_id
              if (id && !rowsOut.some(row => row.id === id)) {
                rowsOut.push({ id, title: session.title || session.name || id, lane: group.label || repo.label || '' })
              }
            }
          }
        }
        return rowsOut
      })
    }).then(list => {
      if (!dead && Array.isArray(list)) { setChats(list); setChatsFor(active.id) }
    }).catch(() => {})
    return () => { dead = true }
  }, [active])

  const select = async id => {
    if (!id || id === EMPTY) {
      ctx.fileWorkspace?.clear()
      setSelected('')
      return
    }
    const workspace = rows.find(item => item.id === id)
    if (!workspace) return
    try {
      if (ctx.fileWorkspace) {
        await ctx.fileWorkspace.select({ id: workspace.id, label: workspace.label || workspace.id })
      }
      setSelected(id)
      ctx.storage.set('selectedWorkspace', id)
      const project = await ensureProjectForWorkspace(ctx, rows, workspace)
      // Current Hermes main exposes Projects but not the retired fileWorkspace
      // bridge. Activating the matching Project preserves the normal File
      // Explorer/new-chat flow without making this plugin depend on a private
      // desktop API.
      if (!ctx.fileWorkspace && project?.id) {
        const host = HOST_RPC()
        if (host && typeof host.request === 'function') {
          await host.request('projects.set_active', { id: project.id })
          refreshSidebarProjects()
        }
      }
    } catch (error) {
      sdkHost.notifyError(error, 'Workspace unavailable')
    }
  }

  const removeWorkspace = async id => {
    const workspace = rows.find(item => item.id === id)
    if (!workspace) return
    if (!window.confirm(`Remove workspace "${workspace.label || id}" from the picker? Files on disk are not touched.`)) return
    try {
      await ctx.rest(`/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (selected === id) { ctx.fileWorkspace?.clear(); setSelected('') }
      refreshRows()
    } catch (error) {
      sdkHost.notifyError(error, 'Remove failed')
    }
  }

  const setWorkspaceVisible = async (workspace, enabled) => {
    if (!workspace || workspace.id === 'local') return
    try {
      await ctx.rest('/workspaces', {
        method: 'POST',
        body: {
          id: workspace.id,
          label: workspace.label,
          provider: workspace.provider,
          host: workspace.host,
          root: workspace.root,
          enabled,
          index_markdown: workspace.index_markdown !== false
        }
      })
      if (!enabled && selected === workspace.id) {
        ctx.fileWorkspace?.clear()
        setSelected('')
      }
      refreshRows(true)
    } catch (error) {
      sdkHost.notifyError(error, enabled ? 'Show workspace failed' : 'Hide workspace failed')
    }
  }

  const openChat = async chat => {
    try { await sdkHost.openSession(chat.id) } catch (error) { sdkHost.notifyError(error, 'Open failed') }
  }

  const startChatHere = async () => {
    const host = HOST_RPC()
    if (!host || typeof host.request !== 'function' || !active) return
    setChatStarting(true)
    try {
      const project = await ensureProjectForWorkspace(ctx, rows, active)
      if (project?.id) await host.request('projects.set_active', { id: project.id })
      sdkHost.newChat()
    } catch (error) {
      sdkHost.notifyError(error, 'Could not start chat')
    } finally {
      setChatStarting(false)
    }
  }

  return React.createElement('div', { className: 'he-wsp' },
    React.createElement('div', { className: 'he-wsp-head' },
      React.createElement('span', null, 'Workspaces'),
      React.createElement('span', { className: 'he-wsp-head-actions' },
        React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', title: 'Add workspace', onClick: () => setAdding(true) }, '+'),
        React.createElement(Button, { type: 'button', variant: manage ? 'default' : 'outline', size: 'sm', title: 'Manage workspace visibility', onClick: () => setManage(value => !value) }, '\u2212'))),
    React.createElement(Select, { value: selected || EMPTY, onValueChange: next => void select(next) },
      React.createElement(SelectTrigger, { className: 'he-wsp-trigger', 'aria-label': 'Files workspace' },
        React.createElement(SelectValue, { placeholder: 'Session files' })),
      React.createElement(SelectContent, null,
        React.createElement(SelectItem, { value: EMPTY }, 'Session files'),
        rows.filter(workspace => workspace.enabled !== false).map(workspace => {
          const remote = workspace.provider === 'ssh'
          const detail = remote ? `SSH ${workspace.host || ''} ${workspace.root_display || workspace.root || ''}`.trim() : `${workspace.root_display || 'Local'}`
          return React.createElement(SelectItem, { key: workspace.id, value: workspace.id },
            `${workspace.label || workspace.id} \u00b7 ${detail}${workspace.online === false ? ' (offline)' : ''}`)
        }))),
    workspaceLoadError && React.createElement('div', { className: 'he-wsp-note he-wsp-offline', role: 'alert' },
      `Could not load workspaces from this Hermes connection: ${workspaceLoadError}. Check that hermes-editor is installed and enabled on the active backend. `,
      React.createElement('button', { type: 'button', onClick: () => refreshRows() }, 'Retry')),
    active?.online === false && React.createElement('div', { className: 'he-wsp-note he-wsp-offline' },
      'This workspace is offline \u2014 files can\u2019t be opened or saved right now. ',
      React.createElement('button', { type: 'button', className: 'he-copylog', onClick: () => void copyPaneLog() }, 'Copy error log')),
    active && React.createElement('div', { className: 'he-wsp-meta' },
      React.createElement(Badge, { variant: 'secondary' }, active.provider === 'ssh' ? `remote \u00b7 ${active.host}` : 'local backend'),
      React.createElement('div', { className: 'he-wsp-root' }, active.root_display || active.root || 'Hermes home')),
    active?.provider === 'local' && React.createElement('div', { className: 'he-wsp-section' },
      React.createElement('div', { className: 'he-wsp-section-title' }, 'Chats in this workspace'),
      chats.length === 0 && React.createElement('div', { className: 'he-wsp-empty' }, chatsFor === active.id ? 'No sessions here yet.' : 'Loading\u2026'),
      chats.map(chat => React.createElement(Button, {
        key: chat.id,
        type: 'button',
        variant: 'ghost',
        size: 'sm',
        className: 'he-wsp-chat',
        title: chat.lane || '',
        onClick: () => void openChat(chat)
      }, chat.title || chat.id))),
    active && React.createElement('div', { className: 'he-wsp-actions' },
      React.createElement(Button, {
        type: 'button',
        variant: 'secondary',
        size: 'sm',
        disabled: active.provider === 'ssh',
        title: active.provider === 'ssh' ? 'Open a file by clicking it in the workspace browser below.' : 'Choose a file from this local workspace.',
        onClick: () => void onOpenFile(active)
      }, active.provider === 'ssh' ? 'Open below' : 'Open file'),
      React.createElement('div', { className: 'he-wsp-project-row' },
        projectLinks[workspaceFolder(active)]
          ? React.createElement(Badge, { variant: 'secondary' }, 'In Projects \u2713')
          : React.createElement(Button, {
              type: 'button',
              variant: 'secondary',
              size: 'sm',
              disabled: linking,
              onClick: () => void addToProjects()
            }, linking ? 'Adding\u2026' : 'Add to Projects')),
      React.createElement(Button, {
        type: 'button',
        variant: 'secondary',
        size: 'sm',
        className: 'he-wsp-newchat',
        disabled: chatStarting,
        onClick: () => void startChatHere()
      }, chatStarting ? 'Starting\u2026' : 'New chat in this workspace')),
    active && React.createElement(FileExplorer, {
      ctx, workspace: active, onOpenFile: onOpenExplorerFile,
      onBeforePathMutation, onPathRemoved, onPathMoved
    }),
    active?.provider === 'ssh' && React.createElement('div', { className: 'he-wsp-note' },
      `Files live on ${active.host}. Chats run on the Hermes backend in this workspace's anchor folder, grouped here as their own project.`),
    manage && React.createElement('div', { className: 'he-wsp-manage' },
      React.createElement('div', { className: 'he-wsp-section-title' }, 'Workspace visibility'),
      rows.filter(workspace => workspace.id !== 'local').map(workspace => React.createElement('div', { key: workspace.id, className: 'he-wsp-manage-row' },
        React.createElement('span', null, workspace.label || workspace.id),
        React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', onClick: () => void setWorkspaceVisible(workspace, workspace.enabled === false) }, workspace.enabled === false ? 'Show' : 'Hide'),
        React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', title: 'Permanently remove workspace', onClick: () => void removeWorkspace(workspace.id) }, '\u2715')))),
    adding && React.createElement(AddWorkspaceDialog, {
      ctx,
      rows,
      onClose: () => setAdding(false),
      onAdded: () => {
        setAdding(false)
        refreshRows()
        loadProjectLinks()
      }
    }))
}

const plugin = {
  id: 'hermes-editor',
  name: 'Hermes Editor',
  description: 'Revision-safe Markdown and code editing in native workspace tabs.',
  register(ctx) {
    ctx.onDispose(installDesktopStyles(__HE_EDITOR_DESKTOP_CSS__))
    ctx.onDispose(installMonacoTheme())
    const workspaces = { current: [], tabs: new Map() }
    const sync = createSync(ctx)
    void hydrateWorkspaces(ctx, workspaces)
    if (ctx.fileWorkspace) {
      ctx.fileWorkspace.registerProvider(createFileWorkspaceProvider(ctx))
    }
    const renderWorkspaceBrowser = () => React.createElement(WorkspacesPane, {
      ctx,
      workspaces,
      onOpenFile: workspace => pickEditorFile(ctx, sync, workspaces, workspace),
      onOpenExplorerFile: (workspace, path) => openEditorWorkspace(ctx, sync, workspaces, workspace, path),
      onBeforePathMutation: (workspace, path, options) => {
        if (affectedEditorTabs(workspaces, workspace, path, options.isDirectory).some(tab => tab.dirty)) {
          sdkHost.notifyError(new Error('Save or close edited tabs inside this item first.'), `${options.operation === 'move' ? 'Move' : 'Delete'} blocked`)
          return false
        }
        return true
      },
      onPathRemoved: (workspace, path, options) => {
        for (const tab of affectedEditorTabs(workspaces, workspace, path, options.isDirectory)) tab.close?.()
      },
      onPathMoved: (workspace, from, to, options) => {
        for (const tab of affectedEditorTabs(workspaces, workspace, from, options.isDirectory)) {
          const nextPath = `${to}${tab.path.slice(from.length)}`
          tab.close?.()
          openEditorWorkspace(ctx, sync, workspaces, workspace, nextPath)
        }
      }
    })
    let browserClose = null
    ctx.onDispose(() => browserClose?.())
    const showEditorWorkspace = () => {
      if (typeof sdkHost.openWorkspace === 'function') {
        browserClose = sdkHost.openWorkspace('hermes-editor:browser', {
          title: 'Hermes Editor · Workspaces',
          minWidth: '32rem',
          render: renderWorkspaceBrowser
        })
      } else {
        sdkHost.revealPane?.('hermes-editor:hermes-editor.workspaces')
      }
    }
    // fileWorkspace is a legacy optional bridge. The public path is the
    // attributed picker + host.openWorkspace below, which also works without it.
    ctx.registerMany([
      {
        area: 'panes',
        id: 'hermes-editor.workspaces',
        title: 'Workspaces',
        data: { placement: 'right', collapsible: true, width: '264px', minWidth: '216px', maxWidth: '380px' },
        render: renderWorkspaceBrowser
      },
      {
        area: PALETTE_AREA,
        id: 'hermes-editor.show-workspaces',
        data: {
          id: 'hermes-editor.show-workspaces',
          label: 'Show Hermes Editor Workspaces',
          keywords: ['editor', 'workspace', 'ssh', 'remote', 'files'],
          run: showEditorWorkspace
        }
      },
      {
        area: PALETTE_AREA,
        id: 'hermes-editor.open-file',
        data: {
          id: 'hermes-editor.open-file',
          label: 'Open file in Hermes Editor',
          keywords: ['editor', 'markdown', 'code', 'workspace', 'file'],
          run: () => void pickEditorFile(ctx, sync, workspaces)
        }
      }
    ])
    // Give the plugin an unmistakable main tab. The built-in Files preview is
    // intentionally left untouched; its Preview/Source/Edit controls are not
    // this rendered, editable Markdown surface.
    ctx.setTimeout(showEditorWorkspace, 0)
    ctx.onDispose(sync.dispose)
  }
}

export default plugin
