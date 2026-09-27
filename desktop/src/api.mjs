export function query(path, values) {
  const entries = Object.entries(values || {}).filter(([, value]) => value !== undefined && value !== null && value !== '')
  return entries.length ? `${path}?${new URLSearchParams(entries)}` : path
}

export function editorApi(ctx) {
  return {
    get: params => ctx.rest(query('/fs/file', params)),
    put: (params, body) => ctx.rest(query('/fs/file', params), { body, method: 'PUT' }),
    index: workspace => ctx.rest(query('/index/state', { workspace })),
    health: workspace => ctx.rest(`/workspaces/${encodeURIComponent(workspace)}/health`)
  }
}
