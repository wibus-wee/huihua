import { useVirtualizer } from '@tanstack/react-virtual'
import type { ContentBlock } from 'huihua/browser'
import { useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { TimelineRow } from '../store.ts'
import { useViewer } from '../store.ts'

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text')
        return block.data
      if (block.type === 'structured')
        return `\`\`\`json\n${JSON.stringify(block.data, null, 2)}\n\`\`\``
      return `[${block.type} attachment]`
    })
    .join('\n\n')
}

function jsonPreview(value: unknown, limit = 160): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="diff">
      {diff.split('\n').map((line, index) => {
        const cls = line.startsWith('+') && !line.startsWith('+++')
          ? 'add'
          : line.startsWith('-') && !line.startsWith('---')
            ? 'del'
            : line.startsWith('@@')
              ? 'hunk'
              : ''
        return <div key={index} className={cls}>{line}</div>
      })}
    </pre>
  )
}

function ToolCallCard({ row }: { row: TimelineRow }) {
  const [open, setOpen] = useState(false)
  const call = row.event
  const result = row.result
  if (call.type !== 'tool_call')
    return null
  const args = call.data.arguments
  const summary = typeof args === 'object' && args !== null && 'command' in args
    ? String((args).command)
    : typeof args === 'object' && args !== null && 'path' in args
      ? String((args).path)
      : jsonPreview(args)
  const isError = result !== undefined && result.type === 'tool_result' && result.data.isError
  return (
    <div className={`card tool ${isError ? 'error' : ''}`}>
      <div className="card-head" onClick={() => setOpen(!open)}>
        <span className="badge">tool</span>
        <span className="tool-name">{call.data.toolName}</span>
        <span className="tool-summary">{summary}</span>
        {isError && <span className="badge fail">error</span>}
        <span className="chevron">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="card-body">
          <JsonBlock value={args} />
          {result !== undefined && result.type === 'tool_result' && (
            <JsonBlock value={result.data.result} />
          )}
        </div>
      )}
    </div>
  )
}

function EventCard({ row }: { row: TimelineRow }) {
  const [open, setOpen] = useState(false)
  const event = row.event
  switch (event.type) {
    case 'user_message':
      return (
        <div className="card user">
          <div className="card-head"><span className="badge">user</span></div>
          <div className="card-body markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{textOf(event.data.content)}</ReactMarkdown>
          </div>
        </div>
      )
    case 'assistant_message':
      return (
        <div className="card assistant">
          <div className="card-head">
            <span className="badge">assistant</span>
            {event.data.model !== undefined && <span className="chip">{event.data.model}</span>}
          </div>
          <div className="card-body markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{textOf(event.data.content)}</ReactMarkdown>
          </div>
        </div>
      )
    case 'reasoning':
      return (
        <div className="card muted">
          <div className="card-head" onClick={() => setOpen(!open)}>
            <span className="badge">reasoning</span>
            <span className="tool-summary">{event.data.summary ?? event.data.text?.slice(0, 120) ?? ''}</span>
            <span className="chevron">{open ? '▾' : '▸'}</span>
          </div>
          {open && (
            <div className="card-body dim">
              {event.data.text ?? <JsonBlock value={event.data.encrypted ?? event.data.summary} />}
            </div>
          )}
        </div>
      )
    case 'tool_call':
      return <ToolCallCard row={row} />
    case 'tool_result':
      return (
        <div className={`card tool ${event.data.isError ? 'error' : ''}`}>
          <div className="card-head" onClick={() => setOpen(!open)}>
            <span className="badge">result</span>
            <span className="tool-name">{event.data.toolName ?? 'tool'}</span>
            {event.data.isError && <span className="badge fail">error</span>}
            <span className="chevron">{open ? '▾' : '▸'}</span>
          </div>
          {open && <div className="card-body"><JsonBlock value={event.data.result} /></div>}
        </div>
      )
    case 'command': {
      const command = typeof event.data.command === 'string' ? event.data.command : jsonPreview(event.data.command)
      return (
        <div className="card command">
          <div className="card-head" onClick={() => setOpen(!open)}>
            <span className="badge">command</span>
            <code className="tool-summary">
              $
              {command}
            </code>
            {event.data.exitCode !== undefined && (
              <span className="chip">
                exit
                {event.data.exitCode}
              </span>
            )}
            <span className="chevron">{open ? '▾' : '▸'}</span>
          </div>
          {open && event.data.output !== undefined && (
            <pre className="card-body terminal">{String(event.data.output)}</pre>
          )}
        </div>
      )
    }
    case 'file_change':
      return (
        <div className="card file">
          <div className="card-head" onClick={() => setOpen(!open)}>
            <span className="badge">{event.data.operation}</span>
            <span className="tool-summary">{event.data.path}</span>
            <span className="chevron">{open ? '▾' : '▸'}</span>
          </div>
          {open && (
            <div className="card-body">
              {event.data.diff !== undefined
                ? <DiffView diff={event.data.diff} />
                : (
                    <JsonBlock value={{ before: event.data.before, after: event.data.after }} />
                  )}
            </div>
          )}
        </div>
      )
    case 'subagent':
      return (
        <div className={`card muted ${event.data.parentAgentId !== undefined ? 'nested' : ''}`}>
          <div className="card-head" onClick={() => setOpen(!open)}>
            <span className="badge">{event.data.kind}</span>
            <span className="tool-name">{event.data.name ?? event.data.agentId}</span>
            <span className="chevron">{open ? '▾' : '▸'}</span>
          </div>
          {open && <div className="card-body"><JsonBlock value={event.data.metadata} /></div>}
        </div>
      )
    case 'usage':
      // Token counts roll up into the toolbar chip; no standalone row.
      return null
    case 'permission_request':
      return (
        <div className="card muted">
          <div className="card-head" onClick={() => setOpen(!open)}>
            <span className="badge">permission</span>
            <span className="tool-summary">{event.data.requestId ?? ''}</span>
            <span className="chevron">{open ? '▾' : '▸'}</span>
          </div>
          {open && <div className="card-body"><JsonBlock value={event.data.request} /></div>}
        </div>
      )
    case 'error':
      return (
        <div className="card error">
          <div className="card-head" onClick={() => setOpen(!open)}>
            <span className="badge fail">error</span>
            <span className="tool-summary">{event.data.message ?? ''}</span>
            <span className="chevron">{open ? '▾' : '▸'}</span>
          </div>
          {open && <div className="card-body"><JsonBlock value={event.data.details} /></div>}
        </div>
      )
    case 'system':
    case 'unknown':
      // Non-conversational records (snapshots, command plumbing, provider internals)
      // stay one-line folded so they don't drown the actual conversation.
      return (
        <div className="card muted compact">
          <div className="card-head" onClick={() => setOpen(!open)}>
            <span className="badge dim">{event.type}</span>
            <span className="tool-summary dim">{event.data.sourceType}</span>
            <span className="chevron">{open ? '▾' : '▸'}</span>
          </div>
          {open && <div className="card-body"><JsonBlock value={event.data.payload} /></div>}
        </div>
      )
  }
}

function Row({ row }: { row: TimelineRow }) {
  const inspectEvent = useViewer(state => state.inspectEvent)
  const inspectorSequence = useViewer(state => state.inspectorSequence)
  const selected = inspectorSequence === row.event.sequence
  const card = <EventCard row={row} />
  if (card === null || row.event.type === 'usage')
    return null
  return (
    <div
      className={`row ${selected ? 'selected' : ''}`}
      onClick={() => inspectEvent(row.event.sequence)}
    >
      {card}
    </div>
  )
}

export function Timeline() {
  const view = useViewer(state => state.view)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [diagOpen, setDiagOpen] = useState(false)
  const rows = view?.rows ?? []
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
  })

  if (view === undefined)
    return null

  return (
    <div className="timeline-wrap">
      <div className="timeline-head">
        <span className="session-title">{view.title ?? view.ref.id}</span>
        <span className="chip">{view.readMode}</span>
        {view.workspace?.path !== undefined && <span className="session-meta">{view.workspace.path}</span>}
        {!view.done && <span className="chip">streaming…</span>}
        {view.openError !== undefined && <span className="badge fail">{view.openError}</span>}
      </div>
      <div ref={scrollRef} className="timeline">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]
            if (row === undefined)
              return null
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
              >
                <Row row={row} />
              </div>
            )
          })}
        </div>
      </div>
      {view.diagnostics.length > 0 && (
        <div className="diagnostics">
          <button
            type="button"
            className="diag-toggle"
            onClick={() => setDiagOpen(!diagOpen)}
          >
            <span className="badge warn">
              {view.diagnostics.length}
              {' '}
              diagnostics
            </span>
            <span className="chevron">{diagOpen ? '▾' : '▸'}</span>
          </button>
          {diagOpen && (
            <div className="diag-list">
              {Array.from(view.diagnosticCounts.entries(), ([code, count]) => (
                <div key={code} className="diag-row">
                  <span className="badge warn">{code}</span>
                  <span className="diag-count">
                    ×
                    {count}
                  </span>
                </div>
              ))}
              <details className="diag-detail">
                <summary>All diagnostics</summary>
                <pre className="json">{JSON.stringify(view.diagnostics, null, 2)}</pre>
              </details>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
