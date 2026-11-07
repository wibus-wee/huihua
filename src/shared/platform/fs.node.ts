import { createReadStream } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

import type { FileSystemSeam, ReadHandle, ReadStreamOptions } from './types.ts'

async function closeStream(input: ReturnType<typeof createReadStream>): Promise<void> {
  if (input.closed)
    return
  // Waiting only for close preserves the original consumer or cancellation error.
  await new Promise<void>((resolve) => {
    input.once('close', resolve)
    input.destroy()
  })
}
export const fs: FileSystemSeam = {
  async stat(path) {
    const facts = await stat(path)
    return { size: facts.size, isFile: facts.isFile(), isDirectory: facts.isDirectory() }
  },
  async identity(path) {
    const facts = await stat(path, { bigint: true })
    return {
      dev: Number(facts.dev),
      ino: Number(facts.ino),
      size: Number(facts.size),
      mtimeNs: facts.mtimeNs,
      ctimeNs: facts.ctimeNs,
    }
  },
  async readdir(path) {
    return readdir(path, { withFileTypes: true })
  },
  realpath: async path => realpath(path),
  async canonical(path) {
    try {
      const absolute = resolve(path)
      const canonical = await realpath(path)
      return canonical === absolute
        || (process.platform === 'darwin' && ['/tmp', '/var'].some(alias => absolute.startsWith(`${alias}/`) && canonical === `/private${absolute}`))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return false
      throw error
    }
  },
  async open(path): Promise<ReadHandle> {
    const handle = await open(path, 'r')
    return {
      async read(target, offset, length, position) {
        const result = await handle.read(target, offset, length, position)
        return { bytesRead: result.bytesRead }
      },
      async stat() {
        const facts = await handle.stat()
        return { size: facts.size, isFile: facts.isFile(), isDirectory: facts.isDirectory() }
      },
      async close() {
        await handle.close()
      },
    }
  },
  async* readStream(path: string, options: ReadStreamOptions) {
    const input = createReadStream(path, {
      highWaterMark: options.highWaterMark,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    try {
      for await (const chunk of input)
        yield chunk as Uint8Array
    }
    finally {
      await closeStream(input)
    }
  },
}
