import { useViewer } from '../store.ts'

export function Inspector() {
  const view = useViewer(state => state.view)
  const sequence = useViewer(state => state.inspectorSequence)
  const record = useViewer(state => state.inspectorRecord)
  const closeInspector = useViewer(state => state.closeInspector)

  const row = view?.rows.find(item => item.event.sequence === sequence)
  if (view === undefined || row === undefined)
    return null

  return (
    <aside className="inspector">
      <div className="inspector-head">
        <span>
          Event #
          {row.event.sequence}
        </span>
        <button type="button" onClick={closeInspector}>×</button>
      </div>
      <div className="inspector-body">
        <h4>Event</h4>
        <pre className="json">{JSON.stringify(row.event, null, 2)}</pre>
        {row.result !== undefined && (
          <>
            <h4>Paired result</h4>
            <pre className="json">{JSON.stringify(row.result, null, 2)}</pre>
          </>
        )}
        <h4>Raw record</h4>
        {record === undefined
          ? <p className="dim">Loading…</p>
          : (
              <>
                <p className="dim">{record.displayPath}</p>
                <pre className="json">
                  {record.record.text ?? JSON.stringify(record.record.native, null, 2)}
                </pre>
              </>
            )}
      </div>
    </aside>
  )
}
