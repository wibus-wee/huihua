import { Buffer } from 'node:buffer'
import { open } from 'node:fs/promises'

import { SessionError } from '../contracts/diagnostic.ts'
import { ioError } from './paths.ts'
import { decodeValue } from './sqlite.ts'

export async function readJson(
  path: string,
  limit: number,
  prefix = false,
  signal?: AbortSignal,
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
        `JSON record exceeds ${limit} bytes`,
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
    return decodeValue(data.subarray(0, offset))
  }
  finally {
    await file.close()
  }
}
