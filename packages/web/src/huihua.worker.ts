import * as Comlink from 'comlink'
import type {
  PortableEntry,
  PortableStore,
  RawRecord,
  ScanEvent,
  SessionFrame,
  SessionRef,
  WorkspaceRef,
} from 'huihua/browser'
import { allProviderRoots, jsonOf, mount, sessions } from 'huihua/browser'

/**
 * The portable mount table is per-context, so mount, scan and every open read all live
 * inside this worker; the main thread only hands over blobs and receives described frames.
 */
export interface MountSummary {
  readonly mode: PortableStore['mode']
  readonly files: number
  readonly bytes: number
  readonly homeDir: string | undefined
  /** Explicit per-provider roots when the mount is not home-shaped. */
  readonly roots: Record<string, readonly string[]>
}

export interface OpenedSession {
  readonly ref: SessionRef
  readonly readMode: 'incremental' | 'buffered'
}

export interface RawRecordEnvelope {
  readonly record: RawRecord
  readonly displayPath: string
}

interface ActiveSession {
  readonly opened: Awaited<ReturnType<typeof sessions.open>>
  /** Set by cancelOpen; makes the read loop early-return, which closes the source. */
  cancelled: boolean
}

let store: PortableStore | undefined
let active: ActiveSession | undefined

function requireStore(): PortableStore {
  if (store === undefined)
    throw new Error('no mounted store')
  return store
}

/** Rewrites a workspace path to what the user handed over; drops it when not mounted. */
function describeWorkspace(s: PortableStore, workspace: WorkspaceRef | undefined): WorkspaceRef | undefined {
  if (workspace?.path === undefined)
    return workspace
  const display = s.describe(workspace.path)
  if (display === undefined)
    return workspace
  return { ...workspace, path: display }
}

/** Resolves the user-facing source path back to its mounted absolute path. */
function mountedRef(s: PortableStore, ref: SessionRef): SessionRef {
  const path = s.paths.includes(ref.source.path) ? ref.source.path : `${s.root}/${ref.source.path}`
  return { ...ref, source: { ...ref.source, path } }
}

function describeFrame(s: PortableStore, frame: SessionFrame): SessionFrame {
  if (frame.type === 'metadata') {
    const workspace = describeWorkspace(s, frame.patch.workspace)
    return workspace === frame.patch.workspace
      ? frame
      : { type: 'metadata', patch: { ...frame.patch, ...(workspace === undefined ? {} : { workspace }) } }
  }
  if (frame.type === 'record') {
    const display = s.describe(frame.record.source.path)
    return display === undefined ? frame : { ...frame, record: { ...frame.record, source: { ...frame.record.source, path: display } } }
  }
  return frame
}

const api = {
  mount(entries: readonly PortableEntry[], options: { as?: 'home' | 'files' } = {}): MountSummary {
    api.dispose()
    store = mount(entries, options)
    const s = requireStore()
    return {
      mode: s.mode,
      files: s.files,
      bytes: s.bytes,
      homeDir: s.homeDir,
      roots: s.mode === 'home' ? {} : allProviderRoots(s.paths),
    }
  },

  async scan(onEvent: (event: ScanEvent) => void): Promise<void> {
    const s = requireStore()
    for await (const event of sessions.scanStream(
      s.mode === 'home' && s.homeDir !== undefined ? { homeDir: s.homeDir } : { roots: allProviderRoots(s.paths) },
    )) {
      if (event.type === 'ref') {
        const displayPath = s.describe(event.ref.source.path) ?? event.ref.source.path
        const workspace = describeWorkspace(s, event.ref.workspace)
        onEvent({
          ...event,
          ref: {
            ...event.ref,
            ...(workspace === undefined ? {} : { workspace }),
            source: { ...event.ref.source, path: displayPath },
          },
        })
      }
      else {
        const failure = event.failure
        const source = failure.source === undefined
          ? undefined
          : {
              ...failure.source,
              path: s.describe(failure.source.path) ?? failure.source.path,
            }
        onEvent({ ...event, failure: { ...failure, ...(source === undefined ? {} : { source }) } })
      }
    }
  },

  /** Prepares a session for streaming; the previous active session is cancelled first. */
  async open(ref: SessionRef): Promise<OpenedSession> {
    const s = requireStore()
    api.cancelOpen()
    const session = await sessions.open(mountedRef(s, ref))
    active = { opened: session, cancelled: false }
    return { ref, readMode: session.readMode }
  },

  /**
   * Streams event/diagnostic/metadata frames in batches; returns on EOF or cancelOpen().
   * Record frames carry the full native text/bytes and are never rendered, so they are
   * excluded via select() where supported, or dropped worker-side otherwise — shipping
   * every RawRecord across postMessage is what makes large sessions feel stuck.
   */
  async read(onFrames: (frames: readonly SessionFrame[]) => void): Promise<void> {
    const s = requireStore()
    const slot = active
    if (slot === undefined)
      return
    const frames = slot.opened.select !== undefined
      ? slot.opened.select({ records: false })
      : slot.opened.stream()
    let batch: SessionFrame[] = []
    for await (const frame of frames) {
      if (slot.cancelled)
        break
      if (frame.type === 'record')
        continue
      batch.push(describeFrame(s, frame))
      if (batch.length >= 64) {
        onFrames(batch)
        batch = []
      }
    }
    if (batch.length > 0 && !slot.cancelled)
      onFrames(batch)
  },

  cancelOpen(): void {
    if (active !== undefined)
      active.cancelled = true
    active = undefined
  },

  /** Fetches one raw record by sequence; the record iterator early-returns at the match. */
  async recordAt(ref: SessionRef, sequence: number): Promise<RawRecordEnvelope | undefined> {
    const s = requireStore()
    const opened = await sessions.open(mountedRef(s, ref))
    for await (const record of opened.records()) {
      if (record.sequence === sequence)
        return { record, displayPath: s.describe(record.source.path) ?? record.source.path }
      if (record.sequence > sequence)
        return undefined
    }
    return undefined
  },

  async snapshot(ref: SessionRef): Promise<unknown> {
    const s = requireStore()
    const opened = await sessions.open(mountedRef(s, ref))
    return jsonOf(await opened.snapshot())
  },

  dispose(): void {
    api.cancelOpen()
    store?.dispose()
    store = undefined
  },
}

export type HuihuaWorkerApi = typeof api
Comlink.expose(api)
