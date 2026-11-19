import { SessionError } from '../contracts/diagnostic.ts'
import type { ScanEvent, ScanFailure, ScanOptions } from '../contracts/provider.ts'
import { scanFailure } from '../contracts/provider.ts'
import { ioErrorOf } from './paths.ts'

export interface PrefetchItem<T, R> {
  readonly value: T
  /** Read task started when this item entered the window. */
  readonly ready: Promise<R>
}
/**
 * Scan bounded-concurrency read window. Pull traversal items ahead only while
 * read tasks are in flight, so at most bound reads and one extra traversal
 * step run concurrently; yielding stays in the original pull order.
 */
export async function* prefetch<T, R>(
  bound: number,
  next: () => Promise<IteratorResult<T>>,
  read: (value: T) => Promise<R>,
): AsyncGenerator<PrefetchItem<T, R>> {
  const pending: PrefetchItem<T, R>[] = []
  for (;;) {
    while (pending.length < bound) {
      const result = await next()
      if (result.done)
        break
      // Synchronous throws surface here; rejections are captured for the
      // consumer so a failed read lands at its own position. Attach a handler
      // at once: queued or detached reads never report an unhandled rejection.
      const ready = read(result.value)
      ready.catch(() => {})
      pending.push({ value: result.value, ready })
    }
    const item = pending.shift()
    if (item === undefined)
      return
    yield item
  }
}

/** Only known source errors are recoverable here; unexpected adapter errors stop its provider. */
export async function* scanSource(
  provider: string,
  source: NonNullable<ScanFailure['source']>,
  options: ScanOptions,
  scan: () => AsyncIterable<ScanEvent>,
): AsyncGenerator<ScanEvent> {
  options.signal?.throwIfAborted()
  let yielding = false
  try {
    for await (const event of scan()) {
      options.signal?.throwIfAborted()
      yielding = true
      yield event
      yielding = false
    }
    options.signal?.throwIfAborted()
  }
  catch (error) {
    options.signal?.throwIfAborted()
    if (yielding)
      throw error
    const nativeIO = error instanceof Error && 'code' in error && 'syscall' in error
    if (!(error instanceof SessionError) && !nativeIO)
      throw error
    yield { type: 'failure', failure: scanFailure(provider, nativeIO ? ioErrorOf(error, source.path) : error, source) }
  }
}
