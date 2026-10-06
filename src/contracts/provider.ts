import type { ErrorCode } from './diagnostic.ts'
import { SessionError } from './diagnostic.ts'
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
export interface ScanFailure {
  readonly provider: string
  readonly scope: 'source' | 'provider'
  readonly source?: { readonly path: string, readonly format?: SessionSource['format'] }
  readonly code: ErrorCode | 'Unknown'
  readonly message: string
  readonly cause?: unknown
}
export type ScanEvent
  = | { readonly type: 'ref', readonly ref: SessionRef }
    | { readonly type: 'failure', readonly failure: ScanFailure }
export interface ScanResult {
  readonly refs: readonly SessionRef[]
  readonly failures: readonly ScanFailure[]
}
/** Internal normalization shared by registry orchestration and source boundaries. */
export function scanFailure(provider: string, error: unknown, source?: ScanFailure['source']): ScanFailure {
  return {
    provider,
    scope: source === undefined ? 'provider' : 'source',
    ...(source === undefined ? {} : { source }),
    code: error instanceof SessionError ? error.code : 'Unknown',
    message: error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown scan error',
    cause: error,
  }
}
export function positiveLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new RangeError('resource limits must be positive safe integers')
  return limit
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
  scan: (options?: ScanOptions) => AsyncIterable<ScanEvent>
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
