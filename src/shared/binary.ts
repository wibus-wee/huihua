import { Buffer } from 'node:buffer'

import XXH from 'xxhashjs'

import { SessionError } from '../contracts/diagnostic.ts'

/** Adapter for the established pure-JS XXH64 implementation; no hashing algorithm lives here. */
export class ContentHash {
  readonly #hash = XXH.h64(0)
  update(data: Buffer): void {
    this.#hash.update(data)
  }

  digest(): bigint {
    return BigInt(`0x${this.#hash.digest().toString(16)}`)
  }
}
class ByteReader {
  readonly #source: AsyncIterator<Buffer>
  #chunk: Buffer = Buffer.alloc(0)
  #offset = 0
  constructor(source: AsyncIterable<Buffer>) {
    this.#source = source[Symbol.asyncIterator]()
  }

  async read(size: number, eof = false): Promise<Buffer | undefined> {
    const parts: Buffer[] = []
    let count = 0
    while (count < size) {
      if (this.#offset === this.#chunk.length) {
        const next = await this.#source.next()
        if (next.done) {
          if (eof && count === 0)
            return
          throw new SessionError(
            'CorruptedSession',
            'truncated Zstandard frame',
          )
        }
        this.#chunk = next.value
        this.#offset = 0
      }
      const take = Math.min(size - count, this.#chunk.length - this.#offset)
      parts.push(this.#chunk.subarray(this.#offset, this.#offset + take))
      this.#offset += take
      count += take
    }
    return Buffer.concat(parts, size)
  }

  async close() {
    await this.#source.return?.()
  }
}
/** Validate frame headers before the decoder allocates a window. Feed one bounded block at a time. */
export async function* zstdChunks(
  source: AsyncIterable<Buffer>,
): AsyncGenerator<Buffer> {
  const { Decompress } = await import('fzstd')
  const reader = new ByteReader(source)
  try {
    for (;;) {
      const magic = await reader.read(4, true)
      if (!magic)
        return
      const code = magic.readUInt32LE()
      if ((code & 0xFFFFFFF0) === 0x184D2A50) {
        let remaining = (await reader.read(4))!.readUInt32LE()
        while (remaining) {
          const take = Math.min(remaining, 65536)
          await reader.read(take)
          remaining -= take
        }
        continue
      }
      if (code !== 0xFD2FB528) {
        throw new SessionError(
          'CorruptedSession',
          'invalid Zstandard frame magic',
        )
      }
      const descriptor = (await reader.read(1))![0]!
      const single = (descriptor & 32) !== 0
      const flag = descriptor >>> 6
      const dictFlag = descriptor & 3
      if (descriptor & 8) {
        throw new SessionError(
          'UnsupportedSchema',
          'reserved Zstandard frame flags',
        )
      }
      const wd = single ? undefined : (await reader.read(1))!
      const dictionary = await reader.read(dictFlag === 3 ? 4 : dictFlag)
      if (dictionary!.some(b => b !== 0)) {
        throw new SessionError(
          'UnsupportedSchema',
          'dictionary-compressed Zstandard frame is unsupported',
        )
      }
      const sizeBytes = flag ? 1 << flag : single ? 1 : 0
      const size = await reader.read(sizeBytes)
      let contentSize = 0n
      for (let i = sizeBytes - 1; i >= 0; i--)
        contentSize = (contentSize << 8n) | BigInt(size![i]!)
      if (flag === 1)
        contentSize += 256n
      const base = wd ? 2 ** (10 + (wd[0]! >>> 3)) : 0
      const window = single
        ? contentSize
        : BigInt(base + (base / 8) * (wd![0]! & 7))
      if (window > 33554432n || contentSize > 4294967295n) {
        throw new SessionError(
          'UnsupportedSchema',
          'Zstandard window exceeds 32 MiB or declared frame size exceeds 4 GiB',
        )
      }
      const hash = new ContentHash()
      const output: Buffer[] = []
      let decodedSize = 0n
      const decoder = new Decompress((data) => {
        if (data.length) {
          const block = Buffer.from(data)
          hash.update(block)
          decodedSize += BigInt(block.length)
          output.push(block)
        }
      })
      const push = (data: Buffer, final = false): void => {
        try {
          decoder.push(data, final)
        }
        catch (error) {
          throw new SessionError(
            'CorruptedSession',
            'invalid Zstandard block',
            { cause: error },
          )
        }
      }
      push(
        Buffer.concat([
          magic,
          Buffer.from([descriptor]),
          ...(wd ? [wd] : []),
          dictionary!,
          size!,
        ]),
      )
      let last = false
      while (!last) {
        const head = (await reader.read(3))!
        const bits = head.readUIntLE(0, 3)
        last = (bits & 1) !== 0
        const type = (bits >>> 1) & 3
        const length = bits >>> 3
        if (type === 3 || length > 131072) {
          throw new SessionError(
            'CorruptedSession',
            'invalid Zstandard block header',
          )
        }
        push(
          Buffer.concat([head, (await reader.read(type === 1 ? 1 : length))!]),
        )
        while (output.length) yield output.shift()!
      }
      const checksum = descriptor & 4 ? (await reader.read(4))! : undefined
      if (checksum)
        push(checksum)
      push(Buffer.alloc(0), true)
      if (
        checksum
        && Number(hash.digest() & 0xFFFFFFFFn) !== checksum.readUInt32LE()
      ) {
        throw new SessionError(
          'CorruptedSession',
          'Zstandard content checksum mismatch',
        )
      }
      while (output.length) yield output.shift()!
      if (sizeBytes && decodedSize !== contentSize) {
        throw new SessionError(
          'CorruptedSession',
          'Zstandard content size mismatch',
        )
      }
    }
  }
  finally {
    await reader.close()
  }
}
