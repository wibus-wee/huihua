import type { Diagnostic } from './diagnostic.ts'
import type { EventDataMap, EventType, SessionEvent, Timestamp } from './event.ts'
import type { RawRecord, SessionSource } from './source.ts'

export const SESSION_SCHEMA = 'agent-session/v1' as const
export type Provider
  = 'claude' | 'codex' | 'cursor' | 'opencode' | 'pi' | 'oar' | 'acp' | 'kimi' | 'grok' | 'antigravity' | 'morph' | 'copilot' | 'hermes' | 'openclaw' | 'qwen' | 'devin' | 'fx' | 'cline' | 'deepseek' | 'droid' | (string & {})
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
export interface FrameSelection {
  /** Omitted means all event types; an empty array delivers no events. Sequences are not renumbered. */
  readonly events?: readonly EventType[]
  /** Native evidence frames are included by default. */
  readonly records?: boolean
  /** Metadata frames are included by default. Identity checks still run when these are omitted. */
  readonly metadata?: boolean
  /** Deliver only these top-level metadata patch keys; empty patches are omitted. Omitted means all keys. */
  readonly metadataKeys?: readonly (keyof Extract<SessionFrame, { type: 'metadata' }>['patch'])[]
}
/** A replay opens a fresh read-only source. Source changes between replays are observable. */
export interface OpenSession {
  readonly ref: SessionRef
  /** Buffered readers may collect selected rows or a snapshot; incremental readers deliver records as read. Neither mode promises a fixed memory ceiling. */
  readonly readMode: 'incremental' | 'buffered'
  stream: () => AsyncIterable<SessionFrame>
  /** Optional optimized frame delivery using the same parser. Diagnostics are always delivered. Each replay opens a fresh source. */
  select?: (selection: FrameSelection) => AsyncIterable<SessionFrame>
  /** Optional callback delivery through the same parser; awaits promised consumer work and completes only after successful EOF. */
  consume?: (selection: FrameSelection, consumer: FrameConsumer) => Promise<void>
  /** Optional evidence-free delivery: Usage events with same-record providerMetadata.native_usage_context (model, and provider-specific message_id/request_id), parent lineage and all diagnostics. Completes at validated EOF; no RawRecord frames. */
  consumeUsage?: (consumer: FrameConsumer) => Promise<void>
  /** Optional direct native usage facts through the same mapper; parent lineage and every diagnostic remain ordered. */
  consumeUsageFacts?: (consumer: UsageFactConsumer, options?: UsageFactOptions) => Promise<void>
  events: () => AsyncIterable<SessionEvent>
  records: () => AsyncIterable<RawRecord>
  snapshot: () => Promise<Session>
}
export type FrameConsumer = (frame: SessionFrame) => void | Promise<void>
/** A native usage observation, not a canonical event; record is physical read order, with no inferred values or deduplication. */
export interface UsageFact {
  readonly type: 'usage'
  readonly record: number
  readonly id?: string
  readonly timestamp?: Timestamp
  readonly providerMetadata: Readonly<Record<string, unknown>>
  readonly data: EventDataMap['usage']
}
export type UsageFactItem = UsageFact | Extract<SessionFrame, { type: 'metadata' | 'diagnostic' }>
export type UsageFactConsumer = (item: UsageFactItem) => void | Promise<void>
export interface UsageFactOptions {
  /** Synchronous consumer policy; rejected usage omits its fact, while all source validation/diagnostics still run. */
  readonly acceptTimestamp?: (timestamp: Timestamp | undefined) => boolean
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
