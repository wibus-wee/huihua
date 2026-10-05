import { SessionError } from '../contracts/diagnostic.ts'
import type { ScanEvent, ScanFailure, ScanOptions } from '../contracts/provider.ts'
import { scanFailure } from '../contracts/provider.ts'
import { ioErrorOf } from './paths.ts'

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
