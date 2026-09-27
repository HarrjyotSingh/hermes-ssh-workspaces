/** Populate the renderer's shared workspace snapshot. Public Desktop plugins
 * open their own workspace tabs, so there is no preview-renderer refresh door. */
export async function hydrateWorkspaces(ctx, workspaces) {
  try {
    const result = await ctx.rest('/workspaces')
    workspaces.current = result.workspaces || []
  } catch {
    // Workspace discovery is optional. The picker remains available and will
    // explain when its selected file cannot be mapped to a workspace.
  }
}

/** Match an untagged host preview path to its workspace. File-browser targets
 * for SSH workspaces arrive through the local mirror at
 * `<hermes-home>/remote-workspaces/<workspace-id>/...`, not under the remote
 * workspace's `root_display`, so both path forms must be recognized. */
export function workspaceForPreviewPath(rows, value) {
  const path = String(value || '').replace(/\\/g, '/')
  const mirror = /(?:^|\/)remote-workspaces\/([^/]+)(?:\/|$)/i.exec(path)
  const mirroredWorkspace = mirror ? (rows || []).find(row => String(row.id) === mirror[1]) : null

  if (mirroredWorkspace) {
    return mirroredWorkspace
  }

  const local = (rows || [])
    .filter(row => String(row.provider || '').toLowerCase() === 'local')
    .filter(row => {
      const root = String(row.root_display || row.root || '').replace(/\\/g, '/').replace(/\/+$/, '')

      return root && (path === root || path.startsWith(`${root}/`))
    })
    .sort((a, b) => String(b.root_display || b.root || '').length - String(a.root_display || a.root || '').length)[0]

  if (local) {
    return local
  }

  return null
}

/** A mount namespace is not itself a project root. */
export function isMountContainer(path) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return /(?:^|\/)remote-workspaces$/i.test(normalized)
}

/** Resolve a configured workspace to the concrete folder Desktop may scan. */
export function workspaceProjectRoot(rows, workspace) {
  if (!workspace) return null
  if (workspace.provider === 'local') {
    const root = String(workspace.root_display || workspace.root || '').replace(/\\/g, '/').replace(/\/+$/, '')
    return root.startsWith('/') && !isMountContainer(root) ? root : null
  }
  const localRoot = String((rows.find(item => item.id === 'local') || {}).root_display || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!localRoot.startsWith('/') || !workspace.id || isMountContainer(localRoot)) return null
  const root = `${localRoot}/remote-workspaces/${workspace.id}`
  return isMountContainer(root) ? null : root
}
