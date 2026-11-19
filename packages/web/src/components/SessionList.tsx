import { millisOf } from 'huihua/browser'

import { useViewer } from '../store.ts'

function formatTime(ms: number | undefined): string {
  if (ms === undefined)
    return ''
  return new Date(ms).toLocaleString()
}

export function SessionList() {
  const refs = useViewer(state => state.refs)
  const failures = useViewer(state => state.failures)
  const scanning = useViewer(state => state.scanning)
  const view = useViewer(state => state.view)
  const selectSession = useViewer(state => state.selectSession)

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        Sessions
        {scanning && <span className="chip">scanning…</span>}
      </div>
      <div className="session-list">
        {refs.map(({ ref, displayPath }) => {
          const selected = view?.ref === ref
          return (
            <button
              key={`${ref.provider}:${ref.id}`}
              type="button"
              className={`session-item ${selected ? 'selected' : ''}`}
              onClick={() => void selectSession(ref)}
            >
              <div className="session-item-top">
                <span className="badge provider">{ref.provider}</span>
                <span className="time">{formatTime(millisOf(ref.updatedAt) ?? millisOf(ref.createdAt))}</span>
              </div>
              <div className="session-title">{ref.title ?? ref.id}</div>
              {ref.workspace?.path !== undefined && (
                <div className="session-meta">{ref.workspace.path}</div>
              )}
              <div className="session-meta dim">{displayPath}</div>
            </button>
          )
        })}
        {refs.length === 0 && !scanning && (
          <div className="empty-panel small">No sessions found in the mounted files.</div>
        )}
      </div>
      {failures.length > 0 && (
        <div className="failures">
          <div className="sidebar-head">Scan failures</div>
          {failures.map((failure, index) => (
            <div key={index} className="failure-item" title={failure.message}>
              <span className="badge fail">{failure.provider}</span>
              <span className="failure-path">{failure.source?.path ?? 'provider'}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
