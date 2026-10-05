import { Buffer } from 'node:buffer'
import { createReadStream } from 'node:fs'

import { SessionError } from '../contracts/diagnostic.ts'
import type { ReadOptions } from '../contracts/provider.ts'
import { zstdChunks } from './binary.ts'
import { ioError, positiveLimit } from './paths.ts'
import { parseNative } from './value.ts'

export interface NativeLine {
  readonly position: number
  readonly native: unknown
  readonly text?: string
  readonly bytes?: readonly number[]
  readonly malformed?: boolean
}
async function* chunks(
  path: string,
  compressed: boolean,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const input = createReadStream(path, {
    highWaterMark: 65536,
    ...(signal === undefined ? {} : { signal }),
  })
  try {
    if (!compressed) {
      for await (const chunk of input) {
        signal?.throwIfAborted()
        yield chunk as Buffer
      }
      return
    }
    yield* zstdChunks(input as AsyncIterable<Buffer>)
  }
  catch (error) {
    if (signal?.aborted)
      throw signal.reason
    ioError(error, path)
  }
  finally {
    input.destroy()
  }
}
function line(bytes: Buffer, position: number): NativeLine | undefined {
  if (bytes.every(b => b === 9 || b === 10 || b === 13 || b === 32))
    return
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    return {
      position,
      native: { native_bytes: [...bytes] },
      bytes: [...bytes],
      malformed: true,
    }
  }
  try {
    return { position, native: parseNative(text), text }
  }
  catch {
    return { position, native: text, text, malformed: true }
  }
}
export async function* jsonLines(
  path: string,
  compressed: boolean,
  options: ReadOptions = {},
): AsyncGenerator<NativeLine> {
  yield* jsonLinesFrom(chunks(path, compressed, options.signal), options)
}
/** Shared bounded framing for files and caller-owned byte streams. */
export async function* jsonLinesFrom(
  source: AsyncIterable<Uint8Array>,
  options: ReadOptions = {},
): AsyncGenerator<NativeLine> {
  const limit = positiveLimit(options.maxRecordBytes, 16 * 1024 * 1024)
  let pending: Buffer[] = []
  let size = 0
  let position = 1
  options.signal?.throwIfAborted()
  for await (const bytes of source) {
    options.signal?.throwIfAborted()
    const chunk = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let start = 0
    while (start < chunk.length) {
      options.signal?.throwIfAborted()
      const newline = chunk.indexOf(10, start)
      const end = newline < 0 ? chunk.length : newline + 1
      const part = chunk.subarray(start, end)
      size += part.length
      if (size > limit) {
        throw new SessionError(
          'CorruptedSession',
          `record ${position} exceeds ${limit} bytes`,
        )
      }
      // A caller-owned stream may reuse its buffer when the next chunk is requested.
      pending.push(Buffer.from(part))
      if (newline >= 0) {
        const record = line(Buffer.concat(pending, size), position++)
        if (record)
          yield record
        pending = []
        size = 0
      }
      start = end
    }
  }
  if (size) {
    const record = line(Buffer.concat(pending, size), position)
    if (record)
      yield record
  }
}
/** Bounded prefix only; a truncated final header line is never parsed as a complete record. */
export async function header(
  path: string,
  compressed: boolean,
  budget = 65536,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const limit = positiveLimit(budget, 65536)
  const parts: Buffer[] = []
  let size = 0
  let complete = true
  for await (const chunk of chunks(path, compressed, signal)) {
    const take = Math.min(chunk.length, limit - size)
    parts.push(chunk.subarray(0, take))
    size += take
    if (size >= limit) {
      complete = false
      break
    }
  }
  const data = Buffer.concat(parts, size)
  const records: unknown[] = []
  let start = 0
  for (let position = 1; position <= 8 && start < data.length; position++) {
    const newline = data.indexOf(10, start)
    if (newline < 0 && !complete)
      break
    const end = newline < 0 ? data.length : newline + 1
    const record = line(data.subarray(start, end), position)
    if (record && !record.malformed)
      records.push(record.native)
    start = end
  }
  return records
}
