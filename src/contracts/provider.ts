import type { OpenSession, Session, SessionFrame, SessionRef } from './session.ts'
import type { SessionSource } from './source.ts'

export interface DetectOptions {
  readonly homeDir?: string
  /** Explicit roots replace defaults. An explicit home isolates discovery from process env. */
  readonly roots?: Readonly<Record<string, readonly string[]>>
  readonly signal?: AbortSignal
}
export interface ScanOptions extends DetectOptions {
  readonly providers?: readonly string[]
  readonly headerBytes?: number
}
export interface ReadOptions {
  readonly signal?: AbortSignal
  readonly maxRecordBytes?: number
}
/** One explicitly selected local source; no discovery or format guessing is performed. */
export interface FileInput {
  readonly path: string
  /** Defaults to JSONL. Database and filesystem adapters require their explicit source format. */
  readonly format?: SessionSource['format']
  readonly id?: string
  readonly locator?: SessionSource['locator']
}
/** Already acquired, uncompressed JSONL evidence; source is a provenance label, never opened. */
export interface JsonlInput {
  readonly jsonl: string | Uint8Array | AsyncIterable<Uint8Array>
  readonly source?: string
  readonly id?: string
}
export type SessionInput = FileInput | JsonlInput
export interface ProviderDetection {
  readonly provider: string
  readonly roots: readonly string[]
  readonly available: boolean
}
export interface SessionProvider {
  readonly id: string
  detect: (options?: DetectOptions) => Promise<ProviderDetection>
  scan: (options?: ScanOptions) => Promise<SessionRef[]>
  read: (ref: SessionRef, options?: ReadOptions) => Promise<Session>
  open?: (ref: SessionRef, options?: ReadOptions) => Promise<OpenSession>
  /** Optional acquired-data capability. File inputs use the existing read SPI. */
  parse?: (input: JsonlInput, options?: ReadOptions) => Promise<Session>
  /**
   * Lazy acquired JSONL frames. Each sequence must reject a second iterator request with TypeError.
   * Prefixes are provisional until successful EOF; early return must close the input iterator.
   * Check cancellation between frames/chunks; producers waiting on I/O must handle the signal too.
   */
  stream?: (input: JsonlInput, options?: ReadOptions) => AsyncIterable<SessionFrame>
}
export function defineProvider<T extends SessionProvider>(provider: T): T {
  if (provider.id.trim() === '')
    throw new TypeError('provider id must be nonempty')
  return provider
}
