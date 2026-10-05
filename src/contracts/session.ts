import type { Diagnostic } from './diagnostic.ts'
import type { SessionEvent, Timestamp } from './event.ts'
import type { RawRecord, SessionSource } from './source.ts'

export const SESSION_SCHEMA = 'agent-session/v1' as const
export type Provider
  = 'claude' | 'codex' | 'cursor' | 'opencode' | 'pi' | 'oar' | 'acp' | 'kimi' | 'grok' | 'antigravity' | 'morph' | (string & {})
export interface WorkspaceRef {
  readonly path?: string
  readonly repository?: string
  readonly branch?: string
  readonly commit?: string
}
export interface SessionRef {
  readonly id: string
  readonly provider: Provider
  readonly title?: string
  readonly createdAt?: Timestamp
  readonly updatedAt?: Timestamp
  readonly workspace?: WorkspaceRef
  readonly source: SessionSource
  readonly metadata: Readonly<Record<string, unknown>>
}
export interface Session extends Omit<SessionRef, 'source'> {
  readonly schema: typeof SESSION_SCHEMA
  readonly source: SessionSource
  readonly parentSessionId?: string
  readonly records: readonly RawRecord[]
  readonly events: readonly SessionEvent[]
  readonly diagnostics: readonly Diagnostic[]
}
/** A replay opens a fresh read-only source. Source changes between replays are observable. */
export interface OpenSession {
  readonly ref: SessionRef
  /** Buffered readers may collect selected rows or a snapshot; incremental readers deliver records as read. Neither mode promises a fixed memory ceiling. */
  readonly readMode: 'incremental' | 'buffered'
  stream: () => AsyncIterable<SessionFrame>
  events: () => AsyncIterable<SessionEvent>
  records: () => AsyncIterable<RawRecord>
  snapshot: () => Promise<Session>
}
export type SessionFrame
  = | { readonly type: 'record', readonly record: RawRecord }
    | { readonly type: 'event', readonly event: SessionEvent }
    | { readonly type: 'diagnostic', readonly diagnostic: Diagnostic }
    | {
      readonly type: 'metadata'
      readonly patch: Partial<
        Pick<
          Session,
          | 'id'
          | 'title'
          | 'createdAt'
          | 'updatedAt'
          | 'workspace'
          | 'parentSessionId'
          | 'metadata'
        >
      >
    }
