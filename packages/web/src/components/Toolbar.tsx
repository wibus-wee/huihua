import { useViewer } from '../store.ts'

export function Toolbar() {
  const mount = useViewer(state => state.mount)
  const view = useViewer(state => state.view)
  const status = useViewer(state => state.status)
  const reset = useViewer(state => state.reset)
  const exportSession = useViewer(state => state.exportSession)

  return (
    <div className="toolbar">
      <span className="brand">huihua</span>
      {mount !== undefined && (
        <span className="stats">
          {mount.files}
          {' '}
          files ·
          {(mount.bytes / 1024 / 1024).toFixed(1)}
          {' '}
          MiB ·
          {mount.mode}
          {' '}
          mount
        </span>
      )}
      {view !== undefined && view.usageCount > 0 && (
        <span className="chip">
          {view.usageCount}
          {' '}
          usage events
        </span>
      )}
      {status !== undefined && <span className="status">{status}</span>}
      <span className="spacer" />
      {view !== undefined && (
        <button type="button" onClick={() => void exportSession()}>
          Export JSON
        </button>
      )}
      <button type="button" onClick={() => void reset()}>
        Reset
      </button>
    </div>
  )
}
