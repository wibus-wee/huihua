import { Buffer } from 'node:buffer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { constants, zstdCompressSync } from 'node:zlib'

if (!process.argv.includes('--regenerate'))
  throw new Error('explicit regeneration required')
const source = JSON.parse(
  await readFile('fixtures/binary/checksummed-source.json', 'utf8'),
) as { repeat: number, text: string }
await writeFile(
  'fixtures/binary/checksummed.zst',
  zstdCompressSync(Buffer.from(source.text.repeat(source.repeat)), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  }),
)

await mkdir('fixtures/deepseek/compressed', { recursive: true })
await writeFile(
  'fixtures/deepseek/compressed/session.v4.jsonl.zstd',
  zstdCompressSync(await readFile('fixtures/deepseek/session/session.v4.jsonl'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  }),
)
