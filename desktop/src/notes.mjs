export const normNote = value => String(value || '').replace(/\/$/, '').replace(/^\.?\//, '').replace(/#.*$/, '').replace(/\.md$/i, '').trim().toLowerCase().replace(/[\s_]+/g, '-')

const escapeRe = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Rank note candidates for the `[[` autocomplete (ZenNotes-style ladder).
 *  Pure and dependency-free so the web UI can reuse it verbatim.
 *  `items` are vault paths without the .md extension. Returns at most
 *  `limit` entries shaped { label, sub } where label is the link TARGET
 *  (the basename) and sub is its folder for disambiguation. */
export const rankPages = (items, query, limit = 8) => {
  const q = String(query || '').trim().toLowerCase()
  const scored = []
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue
    const path = String(item)
    const slash = path.lastIndexOf('/')
    const base = slash >= 0 ? path.slice(slash + 1) : path
    const dir = slash >= 0 ? path.slice(0, slash) : ''
    const lPath = path.toLowerCase()
    const lBase = base.toLowerCase()
    let score = -1
    if (!q) score = 5
    else if (lBase === q) score = 0
    else if (lBase.startsWith(q)) score = 1
    else if (new RegExp(`(^|[^a-z0-9])${escapeRe(q)}`).test(lBase)) score = 2
    else if (lBase.includes(q)) score = 3
    else if (lPath.includes(q)) score = 4
    if (score < 0) continue
    scored.push({ score, len: lPath.length, path: lPath, label: base, sub: dir })
  }
  scored.sort((a, b) => a.score - b.score || a.len - b.len || (a.path < b.path ? -1 : 1))
  return scored.slice(0, limit).map(({ label, sub }) => ({ label, sub }))
}

/** Resolve one raw wikilink target against indexed entries — the check that
 *  decides Ctrl+click. Matches anywhere in the space: exact path → path
 *  suffix → basename → title → alias. When several notes share a name
 *  (common in real vaults), an existing note STILL opens — Obsidian rule:
 *  the copy in the linked-from folder wins, else the shortest stable path.
 *  `nearDir` is the current note's folder. Pure; webui-portable. */
export const findEntryByRef = (entries, target, nearDir) => {
  const wanted = normNote(target)
  if (!wanted || !Array.isArray(entries)) return null
  const dirnameOf = p => {
    const i = String(p).lastIndexOf('/')
    return i > 0 ? String(p).slice(0, i) : ''
  }
  const usable = p => /\.md$/i.test(p) && !p.split('/').pop().startsWith('._')
  for (const entry of entries) {
    if (!entry) continue
    const p = String(entry.path || '')
    if (!usable(p)) continue
    if (normNote(p) === wanted) return entry
  }
  const pick = list => {
    if (!list.length) return null
    if (list.length === 1) return list[0]
    if (nearDir) {
      const near = normNote(nearDir)
      const hit = list.find(entry => normNote(dirnameOf(entry.path)) === near)
      if (hit) return hit
    }
    return [...list].sort((a, b) =>
      normNote(a.path).length - normNote(b.path).length ||
      (normNote(a.path) < normNote(b.path) ? -1 : 1))[0]
  }
  const suffix = []
  const base = []
  const title = []
  const alias = []
  for (const entry of entries) {
    if (!entry) continue
    const p = String(entry.path || '')
    if (!usable(p)) continue
    const np = normNote(p)
    if (np.endsWith('/' + wanted)) suffix.push(entry)
    if (normNote(p.split('/').pop()) === wanted) base.push(entry)
    const t = String(entry.title || '')
    if (t && normNote(t) === wanted) title.push(entry)
    if (Array.isArray(entry.aliases) && entry.aliases.some(a => normNote(String(a)) === wanted)) alias.push(entry)
  }
  return pick(suffix) || pick(base) || pick(title) || pick(alias)
}

/** Resolve a standard-Markdown link href relative to the note containing it
 *  (`[x](../Math/Matrices.md)` from `a/b/current.md` → `a/Math/Matrices`).
 *  Pure and webui-portable. Handles `./`, `../`, URL-decoding, angle-bracket
 *  destinations, trailing link titles, and `#fragment` stripping. Returns the
 *  normalized vault-relative target, or null for external URLs, in-page-only
 *  anchors, and paths that escape the root. */
export const resolveRelativeHref = (notePath, href) => {
  let raw = String(href || '').trim()
  if (!raw) return null
  raw = raw.replace(/\s+(?:"[^"]*"|'[^']*')$/, '')          // [x](url "title")
  if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1)
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) return null      // scheme: http:, mailto:, …
  if (raw.startsWith('//')) return null                      // protocol-relative
  const hash = raw.indexOf('#')
  const pathPart = (hash >= 0 ? raw.slice(0, hash) : raw).trim()
  const fragment = hash >= 0 ? raw.slice(hash + 1).trim() : ''
  if (!pathPart) return null                                 // pure "#heading" anchor
  let decoded = pathPart
  try { decoded = decodeURIComponent(pathPart) } catch { /* keep raw */ }
  decoded = decoded.replace(/\.md$/i, '')
  const slash = String(notePath || '').lastIndexOf('/')
  const dir = slash > 0 ? String(notePath).slice(0, slash) : ''
  const joined = dir && !decoded.startsWith('/') ? `${dir}/${decoded}` : decoded.replace(/^\/+/, '')
  const out = []
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!out.length) return null
      out.pop()
      continue
    }
    out.push(part)
  }
  const target = out.join('/')
  return { target: target || null, fragment: fragment || null }
}
