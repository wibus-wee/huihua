import { DropZone } from './components/DropZone.tsx'
import { Inspector } from './components/Inspector.tsx'
import { SessionList } from './components/SessionList.tsx'
import { Timeline } from './components/Timeline.tsx'
import { Toolbar } from './components/Toolbar.tsx'
import { useViewer } from './store.ts'

export function App() {
  const mount = useViewer(state => state.mount)
  const view = useViewer(state => state.view)
  const inspectorSequence = useViewer(state => state.inspectorSequence)
  const walWarnings = useViewer(state => state.walWarnings)
  const error = useViewer(state => state.error)

  if (mount === undefined)
    return <DropZone />

  return (
    <div className="app">
      <Toolbar />
      {walWarnings.length > 0 && (
        <div className="banner warn">
          {walWarnings.map(path => (
            <div key={path}>
              <code>{path}</code>
              {' was mounted without its '}
              <code>-wal</code>
              {' sibling; the newest sessions inside may be invisible.'}
            </div>
          ))}
        </div>
      )}
      {error !== undefined && <div className="banner error">{error}</div>}
      <div className="layout">
        <SessionList />
        {view === undefined
          ? <div className="empty-panel">Select a session to read its timeline.</div>
          : (
              <>
                <Timeline />
                {inspectorSequence !== undefined && <Inspector />}
              </>
            )}
      </div>
    </div>
  )
}
