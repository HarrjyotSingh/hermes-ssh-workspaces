import { query } from './api.mjs'

export function createSync(ctx, pollMs = 3000) {
  const subscriptions = new Map()
  // The public plugin SDK exposes a receive-only socket. The editor always
  // polls revisions as its correctness path, so keep that path authoritative
  // and accept push events only when the host can deliver them. Do not depend
  // on the retired bidirectional `socketChannel` API: throwing here prevents
  // the entire editor from registering and leaves only the host's plain
  // Markdown fallback visible.
  const disposeSocket = typeof ctx.socket === 'function'
    ? ctx.socket('/events', event => {
        if (!event || event.v !== 1) return
        subscriptions.get(`${event.workspace}\u0000${event.path}`)?.onEvent(event)
      })
    : () => {}

  const poll = () => subscriptions.forEach(subscription => {
    const { workspace, path, revision, onEvent } = subscription
    void ctx.rest(query('/fs/revisions', { workspace, paths: path })).then(result => {
      const stat = result.stats?.find(item => item.path === path)
      if (stat && (!stat.exists || stat.revision !== revision)) {
        onEvent({ v: 1, type: stat.exists ? 'file.changed' : 'file.deleted', workspace, path, revision: stat.revision || '' })
      }
    }).catch(() => {})
  })
  const timer = setInterval(poll, pollMs)

  return {
    noteWritten(workspace, path, revision) {
      const key = `${workspace}\u0000${path}`
      const subscription = subscriptions.get(key)
      if (!subscription) return
      subscription.revision = revision || ''
    },
    subscribe(workspace, path, revision, onEvent) {
      const key = `${workspace}\u0000${path}`
      subscriptions.set(key, { workspace, path, revision: revision || '', onEvent })
      return () => {
        subscriptions.delete(key)
      }
    },
    dispose() {
      clearInterval(timer)
      disposeSocket()
    }
  }
}
