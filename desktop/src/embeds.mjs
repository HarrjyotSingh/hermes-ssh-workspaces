const OBSIDIAN_MEDIA_FOLDERS = ['Ink', 'Images', 'attachments']

/** Fast-paths for Obsidian embeds before the bounded vault-wide scan. */
export function embedCandidatePaths(rootBases, relDir, target) {
  const dir = String(relDir || '').replace(/^\/+|\/+$/g, '')
  const clean = String(target || '').replace(/^\/+/, '')
  const candidates = []

  for (const base of rootBases || []) {
    const root = String(base || '').replace(/\/+$/, '')

    if (!root || !clean) continue
    if (dir) candidates.push(`${root}/${dir}/${clean}`)
    candidates.push(`${root}/${clean}`)

    for (const folder of OBSIDIAN_MEDIA_FOLDERS) {
      candidates.push(`${root}/${folder}/${clean}`)
    }
  }

  return [...new Set(candidates)]
}
