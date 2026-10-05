import { Buffer } from 'node:buffer'
import { readFile, writeFile } from 'node:fs/promises'
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
