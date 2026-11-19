import type { DirectoryHandleLike, DropData, PortableEntry } from 'huihua/browser'
import { entriesFromDirectory, entriesFromDrop, entriesFromFileList } from 'huihua/browser'
import { del, get, set } from 'idb-keyval'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useViewer } from '../store.ts'

const HANDLE_KEY = 'huihua:last-directory'
type PermissionState = 'granted' | 'denied' | 'prompt'

interface PermissionedHandle extends DirectoryHandleLike {
  queryPermission?: (options: { mode: 'read' }) => Promise<PermissionState>
  requestPermission?: (options: { mode: 'read' }) => Promise<PermissionState>
}

const supportsPicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window

/** One persisted picker handle; only stored when the File System Access API exists. */
async function savedHandle(): Promise<PermissionedHandle | undefined> {
  try {
    const stored: unknown = await get(HANDLE_KEY)
    if (stored !== undefined && typeof (stored as PermissionedHandle).values === 'function')
      return stored as PermissionedHandle
  }
  catch {
    // IndexedDB unavailable or value unreadable; fall through to a clean start.
  }
  return undefined
}

export function DropZone() {
  const mountEntries = useViewer(state => state.mountEntries)
  const status = useViewer(state => state.status)
  const error = useViewer(state => state.error)
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [resume, setResume] = useState<'none' | 'prompt' | 'granted'>('none')
  const handleRef = useRef<PermissionedHandle | undefined>(undefined)

  const ingest = useCallback(async (entries: readonly PortableEntry[]) => {
    if (entries.length === 0)
      return
    await mountEntries(entries)
  }, [mountEntries])

  useEffect(() => {
    void savedHandle().then(async (handle) => {
      handleRef.current = handle
      if (handle === undefined)
        return
      const permission = await handle.queryPermission?.({ mode: 'read' })
      if (permission === 'granted')
        setResume('granted')
      else
        setResume('prompt')
    })
  }, [])

  const attachHandle = useCallback(async (handle: PermissionedHandle, remember: boolean) => {
    // entriesFromDirectory walks the handle's children and drops the picked directory's
    // own name, unlike drop/webkitdirectory which keep it. Re-prefix so a picked
    // `~/.codex` still mounts as `.codex/sessions/...` and hits the home-mode roots.
    const raw = await entriesFromDirectory(handle)
    const entries = raw.map(entry => ({ ...entry, path: `${handle.name}/${entry.path}` }))
    handleRef.current = handle
    if (remember)
      await set(HANDLE_KEY, handle)
    await ingest(entries)
  }, [ingest])

  const onDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault()
    setDragging(false)
    await ingest(await entriesFromDrop(event.dataTransfer as unknown as DropData))
  }, [ingest])

  return (
    <div
      className={`dropzone ${dragging ? 'dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => void onDrop(event)}
    >
      <div className="dropzone-card">
        <h1>huihua viewer</h1>
        <p>
          Drop an agent store directory — a
          {' '}
          <code>~/.claude</code>
          -style home, or a folder
          of session files — to scan it locally. Nothing is uploaded.
        </p>
        <div className="dropzone-actions">
          <button type="button" onClick={() => inputRef.current?.click()}>
            Choose folder
          </button>
          {supportsPicker && (
            <button
              type="button"
              onClick={() => {
                void (window as unknown as {
                  showDirectoryPicker: () => Promise<PermissionedHandle>
                }).showDirectoryPicker().then(async handle => attachHandle(handle, true))
              }}
            >
              Pick directory
            </button>
          )}
          {resume !== 'none' && (
            <button
              type="button"
              onClick={() => {
                const handle = handleRef.current
                if (handle === undefined)
                  return
                void (async () => {
                  const permission = await handle.requestPermission?.({ mode: 'read' }) ?? 'granted'
                  if (permission === 'granted')
                    await attachHandle(handle, true)
                  else
                    await del(HANDLE_KEY)
                })()
              }}
            >
              {resume === 'granted' ? 'Re-open last directory' : 'Re-open last directory (needs permission)'}
            </button>
          )}
        </div>
        <input
          ref={(element) => {
            inputRef.current = element
            // webkitdirectory has no typed JSX attribute; Chromium directory pick needs it.
            element?.setAttribute('webkitdirectory', '')
          }}
          type="file"
          hidden
          onChange={(event) => {
            const files = event.currentTarget.files
            if (files !== null)
              void ingest(entriesFromFileList(files))
          }}
        />
        {status !== undefined && <p className="status">{status}</p>}
        {error !== undefined && <p className="error-text">{error}</p>}
      </div>
    </div>
  )
}
