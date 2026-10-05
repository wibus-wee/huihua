import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { it } from 'node:test'

import { SessionError } from '../src/index.ts'
import { ContentHash, zstdChunks } from '../src/shared/binary.ts'

function rawFrame(text: string, checksum = true): Buffer {
  const data = Buffer.from(text)
  assert.ok(data.length < 256)
  const block = Buffer.alloc(3)
  block.writeUIntLE((data.length << 3) | 1, 0, 3)
  const hash = new ContentHash()
  hash.update(data)
  const tail = Buffer.alloc(4)
  tail.writeUInt32LE(Number(hash.digest() & 0xFFFFFFFFn))
  return Buffer.concat([
    Buffer.from([
      0x28,
      0xB5,
      0x2F,
      0xFD,
      0x20 | (checksum ? 4 : 0),
      data.length,
    ]),
    block,
    data,
    ...(checksum ? [tail] : []),
  ])
}
async function* bytes(data: Buffer) {
  for (const byte of data) yield Buffer.from([byte])
}
async function decompress(data: Buffer) {
  const parts = []
  for await (const chunk of zstdChunks(bytes(data))) parts.push(chunk)
  return Buffer.concat(parts).toString()
}
void it('XXH64 checksums use published vectors and chunk boundaries', () => {
  for (const [text, expected] of [
    ['', 'ef46db3751d8e999'],
    ['hello', '26c7827d889f6da3'],
  ]) {
    const hash = new ContentHash()
    for (const b of Buffer.from(text!)) hash.update(Buffer.from([b]))
    assert.equal(hash.digest().toString(16), expected)
  }
})
void it('zstandard frames stream across byte boundaries and concatenated checksummed frames', async () => {
  assert.equal(
    await decompress(Buffer.concat([rawFrame('hello'), rawFrame('world')])),
    'helloworld',
  )
})
void it('truncated, corrupt-checksum, dictionary and oversized-window frames fail explicitly', async () => {
  const valid = rawFrame('hello')
  const bad = Buffer.from(valid)
  bad[bad.length - 1] = bad[bad.length - 1]! ^ 1
  await assert.rejects(
    async () => decompress(valid.subarray(0, valid.length - 1)),
    error =>
      error instanceof SessionError && error.code === 'CorruptedSession',
  )
  await assert.rejects(async () => decompress(bad), /checksum mismatch/)
  await assert.rejects(
    async () => decompress(Buffer.from([0x28, 0xB5, 0x2F, 0xFD, 0, 128])),
    error =>
      error instanceof SessionError && error.code === 'UnsupportedSchema',
  )
  await assert.rejects(
    async () => decompress(Buffer.from([0x28, 0xB5, 0x2F, 0xFD, 0x21, 1, 0])),
    error =>
      error instanceof SessionError && error.code === 'UnsupportedSchema',
  )
})

void it('independently produced compressed blocks verify long-content checksum and source drift', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = JSON.parse(
    await readFile('fixtures/binary/checksummed-source.json', 'utf8'),
  ) as { repeat: number, text: string }
  const encoded = await readFile('fixtures/binary/checksummed.zst')
  assert.equal(await decompress(encoded), source.text.repeat(source.repeat))
  encoded[encoded.length - 1] = encoded[encoded.length - 1]! ^ 1
  await assert.rejects(async () => decompress(encoded), /checksum mismatch/)
})

void it('historical Codex compressed fixture has no drift from its JSONL source', async () => {
  const { readFile } = await import('node:fs/promises')
  assert.equal(
    await decompress(await readFile('fixtures/codex/simple.jsonl.zst')),
    await readFile('fixtures/codex/simple.jsonl', 'utf8'),
  )
})
