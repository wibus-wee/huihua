import type { EventBody } from './event.ts'
import type { RawRecord, SessionSource } from './source.ts'

/** Both inputs carry original evidence; a gap must not be interpreted as a valid native record. */
export type DecoderInput
  = | { readonly type: 'record', readonly record: RawRecord }
    | { readonly type: 'gap', readonly record: RawRecord }

/** Contributions refer to evidence delivered to this replay, including contributions at EOF. */
export type DecoderContribution
  = | { readonly type: 'event', readonly record: RawRecord, readonly event: EventBody }
    | { readonly type: 'metadata', readonly record: RawRecord, readonly data: Readonly<Record<string, unknown>> }
    | { readonly type: 'parent_session', readonly record: RawRecord, readonly id: string }

export interface DecoderReplay {
  /** May update private state; must not mutate inputs or previously returned contributions. */
  readonly decode: (input: DecoderInput) => readonly DecoderContribution[]
  /** Called only at successful source EOF. EOF does not establish an agent's completion. */
  readonly finish?: () => readonly DecoderContribution[]
}

/** Trusted synchronous library callbacks, with fresh private state for every replay. */
export interface SessionDecoder {
  /** Unique within the configured provider; also identifies contribution provenance. */
  readonly id: string
  readonly create: (context: {
    readonly provider: string
    /** A locator is provenance, not evidence of session identity or lineage. */
    readonly source: SessionSource
  }) => DecoderReplay
}
