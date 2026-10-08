import { Buffer } from 'node:buffer'
import { open } from 'node:fs/promises'

import { SessionError } from '../contracts/diagnostic.ts'
import { ioError } from './paths.ts'
import { decodeValue } from './sqlite.ts'

async function readBytes(
  path: string,
  limit: number,
  prefix = false,
  signal?: AbortSignal,
  kind = 'JSON',
) {
  signal?.throwIfAborted()
  let file
  try {
    file = await open(path, 'r')
  }
  catch (error) {
    ioError(error, path)
  }
  try {
    const size = (await file.stat()).size
    if (!prefix && size > limit) {
      throw new SessionError(
        'CorruptedSession',
        `${kind} record exceeds ${limit} bytes`,
      )
    }
    const data = Buffer.alloc(Math.min(size, limit))
    let offset = 0
    while (offset < data.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await file.read(
        data,
        offset,
        data.length - offset,
        offset,
      )
      if (!bytesRead)
        break
      offset += bytesRead
    }
    return data.subarray(0, offset)
  }
  finally {
    await file.close()
  }
}
export async function readJson(path: string, limit: number, prefix = false, signal?: AbortSignal) {
  return decodeValue(await readBytes(path, limit, prefix, signal))
}
/** Bounded UTF-8 artifact acquisition shares the JSON file lifecycle without parsing its prose. */
export async function readText(path: string, limit: number, signal?: AbortSignal) {
  const bytes = await readBytes(path, limit, false, signal, 'Text')
  try {
    const text = new TextDecoder('utf8', { fatal: true }).decode(bytes)
    return { native: text, text }
  }
  catch {
    return { native: { native_bytes: [...bytes] }, bytes: [...bytes], malformed: true }
  }
}
