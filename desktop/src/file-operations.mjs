import { query } from './api.mjs'

const HIDDEN_KEY = 'file-explorer.hidden-paths.v1'
const DRIVE_PATH = /^[a-z]:/i

/** Canonicalize a workspace-relative path and reject absolute/traversing paths. */
export function normalizeExplorerPath(value, { allowEmpty = true } = {}) {
  const raw = String(value ?? '').replace(/\\/g, '/')
  if (raw.startsWith('/') || DRIVE_PATH.test(raw)) throw new Error('Explorer paths must be workspace-relative')
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error('Path contains an invalid character')
  const parts = raw.split('/')
  if (parts.some(part => part === '..')) throw new Error('Path cannot leave the workspace')
  const path = parts.filter(part => part && part !== '.').join('/')
  if (!allowEmpty && !path) throw new Error('A file or folder path is required')
  return path
}

function requireWorkspace(workspace) {
  if (!workspace || typeof workspace.id !== 'string' || !workspace.id.trim()) {
    throw new Error('A configured workspace is required')
  }
  return workspace.id
}

function basename(path) {
  return path.split('/').pop() || ''
}

function parentPath(path) {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function cleanHiddenPaths(value) {
  if (!Array.isArray(value)) return []
  const paths = []
  for (const candidate of value) {
    try {
      const path = normalizeExplorerPath(candidate, { allowEmpty: false })
      if (!paths.includes(path)) paths.push(path)
    } catch { /* Ignore stale or corrupt plugin metadata. */ }
  }
  return paths.sort()
}

function storageFor(ctx) {
  if (typeof ctx?.storage?.get !== 'function' || typeof ctx?.storage?.set !== 'function') {
    throw new Error('Plugin storage capability is required for visibility controls')
  }
  return ctx.storage
}

/**
 * Workspace filesystem methods use the plugin's documented REST capability.
 * Hidden paths live only in this plugin's storage and never touch the filesystem.
 */
export function createFileOperations(ctx) {
  if (typeof ctx?.rest !== 'function') throw new Error('Plugin REST capability is required')

  const readHiddenMap = () => {
    const stored = storageFor(ctx).get(HIDDEN_KEY, {})
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  }

  return {
    async list(workspace, directory = '') {
      const workspaceId = requireWorkspace(workspace)
      const path = normalizeExplorerPath(directory)
      const result = await ctx.rest(query('/fs/tree', { path, workspace: workspaceId }))
      const entries = []
      for (const raw of Array.isArray(result?.entries) ? result.entries : []) {
        if (!raw || typeof raw !== 'object') continue
        const rawPath = raw.path || raw.relative_path || (raw.name ? (path ? `${path}/${raw.name}` : raw.name) : '')
        let entryPath
        try { entryPath = normalizeExplorerPath(rawPath, { allowEmpty: false }) } catch { continue }
        // /fs/tree is a direct-child listing; reject malformed or unexpected paths.
        if (parentPath(entryPath) !== path) continue
        const name = String(raw.name || basename(entryPath))
        if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) continue
        entries.push({
          ...raw,
          name,
          path: entryPath,
          isDirectory: Boolean(raw.isDirectory || raw.is_dir || raw.type === 'directory' || raw.type === 'dir')
        })
      }
      return entries
    },

    createFile(workspace, path, content = '') {
      const workspaceId = requireWorkspace(workspace)
      const safePath = normalizeExplorerPath(path, { allowEmpty: false })
      return ctx.rest(query('/fs/file', { workspace: workspaceId }), {
        method: 'PUT',
        body: { path: safePath, content: String(content), base_revision: '', force: false }
      })
    },

    createFolder(workspace, path) {
      const workspaceId = requireWorkspace(workspace)
      const safePath = normalizeExplorerPath(path, { allowEmpty: false })
      return ctx.rest(query('/fs/mkdir', { workspace: workspaceId }), {
        method: 'POST', body: { path: safePath }
      })
    },

    async remove(workspace, path) {
      const workspaceId = requireWorkspace(workspace)
      const safePath = normalizeExplorerPath(path, { allowEmpty: false })
      const result = await ctx.rest(query('/fs/delete', { workspace: workspaceId }), {
        method: 'POST', body: { path: safePath }
      })
      const current = readHiddenMap()
      const paths = cleanHiddenPaths(current[workspaceId])
      const retained = paths.filter(hidden => hidden !== safePath && !hidden.startsWith(`${safePath}/`))
      if (retained.length !== paths.length) storageFor(ctx).set(HIDDEN_KEY, { ...current, [workspaceId]: retained })
      return result
    },

    async move(workspace, from, destinationDirectory) {
      const workspaceId = requireWorkspace(workspace)
      const source = normalizeExplorerPath(from, { allowEmpty: false })
      const destination = normalizeExplorerPath(destinationDirectory)
      if (destination === source || destination.startsWith(`${source}/`)) {
        throw new Error('An item cannot be moved into itself or one of its descendants')
      }
      const to = destination ? `${destination}/${basename(source)}` : basename(source)
      if (to === source) throw new Error('Choose a different destination directory')

      const result = await ctx.rest(query('/fs/move', { workspace: workspaceId }), {
        method: 'POST', body: { from: source, to }
      })

      // Keep plugin-only hidden metadata aligned with moved files and whole trees.
      const current = readHiddenMap()
      const paths = cleanHiddenPaths(current[workspaceId])
      let changed = false
      const moved = paths.map(path => {
        if (path !== source && !path.startsWith(`${source}/`)) return path
        changed = true
        return `${to}${path.slice(source.length)}`
      })
      if (changed) storageFor(ctx).set(HIDDEN_KEY, { ...current, [workspaceId]: cleanHiddenPaths(moved) })
      return result
    },

    async rename(workspace, from, newName) {
      const workspaceId = requireWorkspace(workspace)
      const source = normalizeExplorerPath(from, { allowEmpty: false })
      const name = String(newName || '').trim()
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new Error('Enter a single valid file or folder name')
      }
      const parent = parentPath(source)
      const to = parent ? `${parent}/${name}` : name
      if (to === source) throw new Error('Choose a different name')
      const result = await ctx.rest(query('/fs/move', { workspace: workspaceId }), {
        method: 'POST', body: { from: source, to }
      })
      const current = readHiddenMap()
      const paths = cleanHiddenPaths(current[workspaceId])
      const next = paths.map(path => path === source || path.startsWith(`${source}/`)
        ? `${to}${path.slice(source.length)}` : path)
      if (next.some((path, index) => path !== paths[index])) {
        storageFor(ctx).set(HIDDEN_KEY, { ...current, [workspaceId]: cleanHiddenPaths(next) })
      }
      return result
    },

    hiddenPaths(workspace) {
      const workspaceId = requireWorkspace(workspace)
      const stored = readHiddenMap()
      return cleanHiddenPaths(stored[workspaceId])
    },

    setHidden(workspace, path, hidden) {
      const workspaceId = requireWorkspace(workspace)
      const safePath = normalizeExplorerPath(path, { allowEmpty: false })
      const stored = readHiddenMap()
      const paths = new Set(cleanHiddenPaths(stored[workspaceId]))
      if (hidden) paths.add(safePath)
      else {
        // Revealing a child of a hidden folder must also reveal its hidden
        // ancestors; otherwise the explorer's Unhide action has no effect.
        for (const candidate of paths) {
          if (candidate === safePath || safePath.startsWith(`${candidate}/`)) paths.delete(candidate)
        }
      }
      const next = [...paths].sort()
      storageFor(ctx).set(HIDDEN_KEY, { ...stored, [workspaceId]: next })
      return next
    }
  }
}

/** A hidden folder also hides every descendant in the explorer. */
export function isExplorerPathHidden(path, hiddenPaths) {
  const safePath = normalizeExplorerPath(path)
  return cleanHiddenPaths(hiddenPaths).some(hidden =>
    safePath === hidden || safePath.startsWith(`${hidden}/`))
}

/** Dot-prefixed files and folders are hidden independently of .gitignore. */
export function isDotHiddenPath(path) {
  return normalizeExplorerPath(path).split('/').some(part => part.startsWith('.') && part !== '')
}
