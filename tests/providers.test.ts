import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { it } from 'node:test'

import { sessions } from '../src/index.ts'
import { assertSessionContract } from '../src/testing/index.ts'
import {
  cases,
  fixtureRoot,
  oracleSemantic,
  semantic,
  snapshotPath,
  stableSnapshot,
} from './oracle.ts'

for (const fixture of await cases()) {
  const provider
    = fixture.provider === 'claude_code' ? 'claude' : fixture.provider
  void it(`${provider}: ${fixture.path} retains baseline semantics and canonical evidence`, async () => {
    const refs = await sessions.scan({
      providers: [provider],
      roots: { [provider]: [resolve(fixtureRoot, fixture.path)] },
      homeDir: fixtureRoot,
    })
    assert.equal(refs.length, 1)
    const ref = refs[0]!
    const session = await sessions.read(ref)
    assertSessionContract(session)
    const oracle = JSON.parse(
      await readFile(resolve(fixtureRoot, fixture.golden), 'utf8'),
    ) as {
      id: string
      events: unknown[]
      created_at: unknown
      updated_at: unknown
      parent_session_id: unknown
    }
    assert.deepEqual(
      session.events.map(semantic),
      oracle.events.map(oracleSemantic),
    )
    assert.equal(session.id, oracle.id)
    assert.deepEqual(session.createdAt ?? null, oracle.created_at)
    assert.deepEqual(session.updatedAt ?? null, oracle.updated_at)
    assert.equal(session.parentSessionId ?? null, oracle.parent_session_id)
    assert.deepEqual(
      stableSnapshot(session),
      JSON.parse(await readFile(snapshotPath(fixture), 'utf8')) as unknown,
    )
  })
}
