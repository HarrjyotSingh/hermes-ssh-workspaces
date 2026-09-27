import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createFileOperations, isDotHiddenPath, isExplorerPathHidden, normalizeExplorerPath } from './file-operations.mjs'

const h = React.createElement

/** Mountable plugin-owned file explorer. `onOpenFile(workspace, path)` lets
 *  callers route files into their own editor tab implementation. */
export function FileExplorer({ ctx, workspace, onOpenFile, onBeforePathMutation, onPathRemoved, onPathMoved, operations: suppliedOperations }) {
  const operations = useMemo(() => suppliedOperations || createFileOperations(ctx), [ctx, suppliedOperations])
  const [directory, setDirectory] = useState('')
  const [entries, setEntries] = useState([])
  const [hiddenPaths, setHiddenPaths] = useState([])
  const [showHidden, setShowHidden] = useState(false)
  const [newName, setNewName] = useState('')
  const [createKind, setCreateKind] = useState('file')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    if (!workspace?.id) return
    const request = ++requestId.current
    setError('')
    try {
      const [nextEntries, hidden] = await Promise.all([
        operations.list(workspace, directory),
        Promise.resolve(operations.hiddenPaths(workspace))
      ])
      if (request !== requestId.current) return
      setEntries(nextEntries)
      setHiddenPaths(hidden)
    } catch (err) {
      if (request !== requestId.current) return
      // A folder may have been deleted or moved while it was open. Walk up
      // toward a directory that still exists instead of leaving a dead view.
      if (directory && (err?.status === 404 || /directory not found|not found/i.test(String(err?.message || err)))) {
        setDirectory(directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '')
        return
      }
      setError(String(err?.message || err))
    }
  }, [operations, workspace, directory])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    setDirectory('')
    setEntries([])
  }, [workspace?.id])

  const create = async event => {
    event.preventDefault()
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setError('')
    try {
      const path = normalizeExplorerPath(directory ? `${directory}/${name}` : name, { allowEmpty: false })
      if (createKind === 'folder') await operations.createFolder(workspace, path)
      else await operations.createFile(workspace, path)
      setNewName('')
      await refresh()
    } catch (err) { setError(String(err?.message || err)) }
    finally { setBusy(false) }
  }

  const toggleHidden = async entry => {
    const hidden = isExplorerPathHidden(entry.path, hiddenPaths)
    try {
      setHiddenPaths(operations.setHidden(workspace, entry.path, !hidden))
    } catch (err) { setError(String(err?.message || err)) }
  }

  const remove = async entry => {
    const kind = entry.isDirectory ? 'folder and its contents' : 'file'
    if (!globalThis.confirm?.(`Delete ${kind} “${entry.path}”?`)) return
    setBusy(true)
    setError('')
    try {
      if (await onBeforePathMutation?.(workspace, entry.path, { isDirectory: entry.isDirectory, operation: 'delete' }) === false) return
      await operations.remove(workspace, entry.path)
      await onPathRemoved?.(workspace, entry.path, { isDirectory: entry.isDirectory })
      await refresh()
    } catch (err) { setError(String(err?.message || err)) }
    finally { setBusy(false) }
  }

  const move = async entry => {
    const target = globalThis.prompt?.(`Move “${entry.name}” to a workspace-relative directory (blank for workspace root):`, directory) ?? null
    if (target === null) return
    setBusy(true)
    setError('')
    try {
      if (await onBeforePathMutation?.(workspace, entry.path, { isDirectory: entry.isDirectory, operation: 'move' }) === false) return
      const result = await operations.move(workspace, entry.path, target)
      await onPathMoved?.(workspace, entry.path, result?.to || `${target ? `${normalizeExplorerPath(target)}/` : ''}${entry.name}`, { isDirectory: entry.isDirectory })
      await refresh()
    } catch (err) { setError(String(err?.message || err)) }
    finally { setBusy(false) }
  }

  const rename = async entry => {
    const name = globalThis.prompt?.(`Rename “${entry.name}” to:`, entry.name) ?? null
    if (name === null) return
    setBusy(true)
    setError('')
    try {
      if (await onBeforePathMutation?.(workspace, entry.path, { isDirectory: entry.isDirectory, operation: 'move' }) === false) return
      const result = await operations.rename(workspace, entry.path, name)
      await onPathMoved?.(workspace, entry.path, result?.to, { isDirectory: entry.isDirectory })
      await refresh()
    } catch (err) { setError(String(err?.message || err)) }
    finally { setBusy(false) }
  }

  const isHidden = entry => isDotHiddenPath(entry.path) || isExplorerPathHidden(entry.path, hiddenPaths)
  const visibleEntries = entries.filter(entry => showHidden || !isHidden(entry))
  const hiddenHere = entries.filter(isHidden)
  const segments = directory ? directory.split('/') : []
  const crumbButtons = [h('button', { key: 'root', type: 'button', onClick: () => setDirectory('') }, workspace?.label || workspace?.id || 'Workspace')]
  segments.forEach((segment, index) => {
    const path = segments.slice(0, index + 1).join('/')
    crumbButtons.push(h('span', { key: `sep-${index}`, 'aria-hidden': true }, ' / '))
    crumbButtons.push(h('button', { key: path, type: 'button', onClick: () => setDirectory(path) }, segment))
  })

  if (!workspace?.id) return h('div', { className: 'he-file-explorer' }, 'Select a workspace to browse files.')

  return h('section', { className: 'he-file-explorer', 'aria-label': 'Workspace file explorer' },
    h('header', { className: 'he-file-explorer-header' },
      h('nav', { 'aria-label': 'Current directory' }, ...crumbButtons),
      h('button', { type: 'button', onClick: () => void refresh(), disabled: busy }, 'Refresh')),
    h('form', { className: 'he-file-explorer-create', onSubmit: create },
      h('select', { 'aria-label': 'New item type', value: createKind, onChange: event => setCreateKind(event.currentTarget.value) },
        h('option', { value: 'file' }, 'File'), h('option', { value: 'folder' }, 'Folder')),
      h('input', { 'aria-label': 'New item name', value: newName, onChange: event => setNewName(event.currentTarget.value), placeholder: 'Name', disabled: busy }),
      h('button', { type: 'submit', disabled: busy || !newName.trim() }, 'Create')),
    h('label', { className: 'he-file-explorer-hidden-toggle' },
      h('input', { type: 'checkbox', checked: showHidden, onChange: event => setShowHidden(event.currentTarget.checked) }),
      'Show hidden files and folders (dotfiles; not gitignored files)'),
    error && h('div', { role: 'alert', className: 'he-file-explorer-error' }, error),
    h('ul', { className: 'he-file-explorer-list' },
      visibleEntries.map(entry => {
        const hidden = isHidden(entry)
        const manuallyHidden = isExplorerPathHidden(entry.path, hiddenPaths)
        return h('li', { key: entry.path, className: hidden ? 'is-hidden' : '' },
          entry.isDirectory
            ? h('button', { type: 'button', className: 'he-file-explorer-name', onClick: () => setDirectory(entry.path), 'aria-label': `Open folder ${entry.name}` }, `📁 ${entry.name}`)
            : h('button', { type: 'button', className: 'he-file-explorer-name', onClick: () => {
              Promise.resolve(onOpenFile?.(workspace, entry.path)).catch(err => setError(String(err?.message || err)))
            }, disabled: typeof onOpenFile !== 'function' }, `📄 ${entry.name}`),
          h('span', { className: 'he-file-explorer-actions' },
            h('button', { type: 'button', onClick: () => void toggleHidden(entry), 'aria-label': manuallyHidden ? `Unhide ${entry.name}` : `Hide ${entry.name}` }, manuallyHidden ? 'Unhide' : 'Hide'),
            h('button', { type: 'button', onClick: () => void rename(entry), disabled: busy, 'aria-label': `Rename ${entry.name}` }, 'Rename'),
            h('button', { type: 'button', onClick: () => void move(entry), disabled: busy, 'aria-label': `Move ${entry.name}` }, 'Move'),
            h('button', { type: 'button', onClick: () => void remove(entry), disabled: busy, 'aria-label': `Delete ${entry.name}` }, 'Delete')))
      }),
      showHidden && hiddenHere.filter(entry => !visibleEntries.some(visible => visible.path === entry.path)).map(entry =>
        h('li', { key: entry.path, className: 'is-hidden' },
          entry.isDirectory
            ? h('button', { type: 'button', className: 'he-file-explorer-name', onClick: () => setDirectory(entry.path) }, `📁 ${entry.name}`)
            : h('button', { type: 'button', className: 'he-file-explorer-name', onClick: () => onOpenFile?.(workspace, entry.path) }, `📄 ${entry.name}`),
          h('button', { type: 'button', onClick: () => void toggleHidden(entry), 'aria-label': `Unhide ${entry.name}` }, 'Unhide'))),
      visibleEntries.length === 0 && (hiddenHere.length > 0
        ? !showHidden && h('li', { className: 'he-file-explorer-empty' }, 'All items in this folder are hidden.')
        : h('li', { className: 'he-file-explorer-empty' }, 'This folder is empty.'))))
}

export default FileExplorer
