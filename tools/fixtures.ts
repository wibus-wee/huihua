import { readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'

import { cases } from '../tests/oracle.ts'

if (!process.argv.includes('--regenerate')) {
  throw new Error(
    'explicit regeneration required: pnpm fixtures --regenerate',
  )
}
for (const fixture of (await cases()).filter(c => c.path.endsWith('.db'))) {
  const path = resolve('fixtures', fixture.path)
  const sql = await readFile(path.replace(/\.db$/, '.sql'), 'utf8')
  await rm(path, { force: true })
  const db = new DatabaseSync(path)
  try {
    db.exec(sql)
  }
  finally {
    db.close()
  }
}
