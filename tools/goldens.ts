import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

import { sessions } from '../src/index.ts'
import {
  cases,
  fixtureRoot,
  snapshotPath,
  stableSnapshot,
} from '../tests/oracle.ts'

if (!process.argv.includes('--update'))
  throw new Error('explicit update required: pnpm goldens --update')
for (const fixture of await cases()) {
  const provider
    = fixture.provider === 'claude_code' ? 'claude' : fixture.provider
  const refs = await sessions.scan({
    providers: [provider],
    roots: { [provider]: [resolve(fixtureRoot, fixture.path)] },
    homeDir: fixtureRoot,
  })
  if (refs.length !== 1)
    throw new Error(`unexpected refs: ${fixture.path}`)
  const session = await sessions.read(refs[0]!)
  await writeFile(
    snapshotPath(fixture),
    `${JSON.stringify(stableSnapshot(session), null, 2)}\n`,
  )
}
