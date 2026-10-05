import type { EventType, SessionEvent } from '../contracts/event.ts'
import type { Session } from '../contracts/session.ts'

/** Select existing events in source order, retaining duplicates and evidence references. */
export function eventsOf<K extends EventType>(
  session: Pick<Session, 'events'>,
  ...types: [K, ...K[]]
): readonly Extract<SessionEvent, { type: K }>[] {
  if (types.length === 0)
    throw new TypeError('eventsOf requires at least one event type')
  const selectedTypes: readonly EventType[] = types
  return session.events.filter(
    (event): event is Extract<SessionEvent, { type: K }> =>
      selectedTypes.includes(event.type),
  )
}

/** User and assistant messages remain unmerged, including mirrored records and split blocks. */
export function conversationOf(session: Pick<Session, 'events'>) {
  return eventsOf(session, 'user_message', 'assistant_message')
}
export function toolCallsOf(session: Pick<Session, 'events'>) {
  return eventsOf(session, 'tool_call')
}
/** Results remain independent of calls; repeated IDs do not establish a unique match. */
export function toolResultsOf(session: Pick<Session, 'events'>) {
  return eventsOf(session, 'tool_result')
}
export function fileChangesOf(session: Pick<Session, 'events'>) {
  return eventsOf(session, 'file_change')
}
export function subagentsOf(session: Pick<Session, 'events'>) {
  return eventsOf(session, 'subagent')
}
