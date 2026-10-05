export interface SessionSource {
  readonly path: string
  readonly format:
    | 'jsonl'
    | 'jsonl_zstd'
    | 'cursor_sqlite'
    | 'opencode_sqlite'
    | 'opencode_files'
    | 'antigravity_sqlite'
    | 'morph_journal'
    | (string & {})
  readonly locator?: Readonly<Record<string, unknown>>
}

/** Evidence is retained once per persisted record, even when it emits several events. */
export interface RawRecord {
  readonly sequence: number
  readonly provider: string
  readonly type?: string
  readonly native: unknown
  /** Original UTF-8 JSON preserves numeric lexemes and fields the parser does not understand. */
  readonly text?: string
  /** Invalid UTF-8 or binary SQL values remain reachable without lossy replacement characters. */
  readonly bytes?: readonly number[]
  readonly source: {
    readonly path: string
    readonly position?: number
    readonly table?: string
    readonly key?: string
  }
}
