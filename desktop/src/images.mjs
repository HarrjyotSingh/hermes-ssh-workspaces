import { query } from './api.mjs'

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i
const MEDIA_DIRS = ['Ink', 'Images', 'attachments']
const SKIP_DIR = /^(?:\.git|\.hg|\.svn|node_modules|__pycache__|venv|\.venv|\.obsidian)$/i
const resolvedPaths = new Map()

function cleanTarget(target) {
  let value = String(target || '').split('#')[0].split('|')[0].trim()
  try { value = decodeURIComponent(value) } catch { /* Keep the literal path. */ }
  return value.replace(/\\/g, '/')
}

function imagePathTarget(target) {
  // Query strings are valid on external URLs, but workspace files are
  // addressed by path. Keep this before decodeURIComponent so an encoded
  // question mark can still name a literal file.
  return String(target || '').split('#')[0].split('|')[0].split('?')[0].trim()
}

function joinInsideWorkspace(base, target) {
  const path = target.startsWith('/') ? target.slice(1) : `${base ? `${base}/` : ''}${target}`
  const parts = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else if (/[\u0000-\u001f\u007f]/.test(part)) return null
    else parts.push(part)
  }
  return parts.join('/') || null
}

export function imageCandidatePaths(notePath, target) {
  const clean = cleanTarget(imagePathTarget(target))
  if (!IMAGE_EXT.test(clean) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)) return []
  const noteDir = String(notePath || '').split('/').slice(0, -1).join('/')
  const candidates = [joinInsideWorkspace(noteDir, clean), joinInsideWorkspace('', clean)]
  for (const dir of MEDIA_DIRS) candidates.push(joinInsideWorkspace('', `${dir}/${clean}`))
  return [...new Set(candidates.filter(Boolean))]
}

async function listDirectory(ctx, workspaceId, path) {
  try {
    const response = await ctx.rest(query('/fs/tree', { workspace: workspaceId, path }))
    return Array.isArray(response?.entries) ? response.entries : []
  } catch { return [] }
}

async function findByBasename(ctx, workspaceId, target, notePath) {
  const wanted = target.split('/').pop()?.toLowerCase()
  if (!wanted) return null
  const noteDir = String(notePath || '').split('/').slice(0, -1).join('/')
  const queue = [...new Set([noteDir, '', ...MEDIA_DIRS])]
  const seen = new Set()
  let remaining = 120
  while (queue.length && remaining-- > 0) {
    const dir = queue.shift()
    if (seen.has(dir)) continue
    seen.add(dir)
    for (const entry of await listDirectory(ctx, workspaceId, dir)) {
      const name = String(entry?.name || '')
      const path = joinInsideWorkspace('', String(entry?.path || (dir ? `${dir}/${name}` : name)))
      if (!name || !path) continue
      if (entry.type === 'dir' || entry.is_dir || entry.isDirectory) {
        if (!name.startsWith('.') && !SKIP_DIR.test(name)) queue.push(path)
      } else if (name.toLowerCase() === wanted) return path
    }
  }
  return null
}

/** Read image bytes through this plugin's workspace-addressed backend route. */
export async function loadWorkspaceImage(ctx, workspace, target, notePath) {
  const raw = String(target || '').trim()
  if (/^(?:https?:|data:image\/|blob:|\/\/)/i.test(raw)) return raw
  const fileTarget = imagePathTarget(target)
  const pathClean = cleanTarget(fileTarget)
  if (!workspace?.id || !IMAGE_EXT.test(pathClean)) return null
  const key = `${workspace.id}|${notePath}|${pathClean}`
  const candidates = imageCandidatePaths(notePath, fileTarget)
  const cached = resolvedPaths.get(key)
  if (cached) candidates.unshift(cached)
  const read = async path => {
    try {
      const result = await ctx.rest(query('/fs/image', { workspace: workspace.id, path }))
      return typeof result?.data_url === 'string' && result.data_url.startsWith('data:image/') ? result.data_url : null
    } catch { return null }
  }
  for (const path of new Set(candidates)) {
    const dataUrl = await read(path)
    if (dataUrl) { resolvedPaths.set(key, path); return dataUrl }
  }
  const found = await findByBasename(ctx, workspace.id, pathClean, notePath)
  if (found) {
    const dataUrl = await read(found)
    if (dataUrl) { resolvedPaths.set(key, found); return dataUrl }
  }
  return null
}
