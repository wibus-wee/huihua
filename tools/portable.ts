import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import type { ScanOptions } from '../src/contracts/provider.ts'
import type { Session, SessionRef } from '../src/contracts/session.ts'
import { sessions } from '../src/index.ts'
import { cases, fixtureRoot } from '../tests/oracle.ts'

/**
 * The portable build owns no Node builtins and no network APIs, so a browser consumer can import it
 * as-is. It is loaded dynamically because it only exists after a build, which keeps this check honest
 * about the artifact consumers install instead of re-testing the source graph twice.
 */
interface PortableStore {
  readonly root: string
  readonly homeDir: string | undefined
  readonly paths: readonly string[]
  dispose: () => void
}
interface PortableBundle {
  readonly sessions: {
    scan: (options?: ScanOptions) => Promise<{ refs: readonly SessionRef[], failures: readonly unknown[] }>
    read: (ref: SessionRef) => Promise<Session>
  }
  readonly mount: (entries: Iterable<{ path: string, blob: Blob }>, options?: { as?: 'home' | 'files' }) => PortableStore
  readonly jsonOf: (session: Session) => unknown
}
async function portableBundle(): Promise<PortableBundle> {
  const loaded: unknown = await import(new URL('../dist/browser/index.js', import.meta.url).href)
  const bundle = loaded as PortableBundle
  assert.equal(typeof bundle.mount, 'function', 'portable entry must expose mount')
  assert.equal(typeof bundle.sessions.scan, 'function', 'portable entry must expose scan')
  return bundle
}
/** Rewrite the synthetic prefix so evidence paths compare against the real fixture paths. */
function canonical(value: unknown, prefix: string): string {
  return JSON.stringify(value).split(prefix).join(JSON.stringify(fixtureRoot).slice(1, -1))
}
async function fixtureEntries(): Promise<{ path: string, blob: Blob }[]> {
  const output: { path: string, blob: Blob }[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      output.push({
        path: relative(fixtureRoot, path).split('\\').join('/'),
        blob: new File([new Uint8Array(await readFile(path))], entry.name),
      })
    }
  }
  await visit(fixtureRoot)
  return output
}
/** Architecture and parity check for the browser arm: same corpus, same evidence, no host platform. */
export async function portable(): Promise<void> {
  const artifact = await readFile('dist/browser/index.js', 'utf8')
  assert.doesNotMatch(artifact, /from\s*"node:/, 'portable artifact must not import Node builtins')
  assert.doesNotMatch(artifact, /(?:^|[\s("'`])(?:fetch|XMLHttpRequest|WebSocket|sendBeacon|EventSource)\s*\(/, 'the portable artifact must not contain network APIs')
  assert.doesNotMatch(artifact, /from\s*"#/, 'seams must be resolved by the build, not left for consumers')

  const bundle = await portableBundle()
  const store = bundle.mount(await fixtureEntries(), { as: 'files' })
  try {
    let compared = 0
    for (const fixture of await cases()) {
      const provider = fixture.provider === 'claude_code' ? 'claude' : fixture.provider
      const mounted = `${store.root}/${fixture.path.split('\\').join('/')}`
      assert.ok(store.paths.some(path => path === mounted || path.startsWith(`${mounted}/`)), `mounted fixture missing: ${fixture.path}`)
      const roots = { [provider]: [mounted] }
      const native = await sessions.scan({ providers: [provider], roots: { [provider]: [resolve(fixtureRoot, fixture.path)] }, homeDir: fixtureRoot })
      const portableScan = await bundle.sessions.scan({ providers: [provider], roots })
      assert.equal(portableScan.failures.length, 0, `${fixture.path}: portable scan reported failures`)
      assert.equal(native.failures.length, 0, `${fixture.path}: native scan reported failures`)
      assert.deepEqual(
        portableScan.refs.map(ref => ({ provider: ref.provider, id: ref.id })),
        native.refs.map(ref => ({ provider: ref.provider, id: ref.id })),
        `${fixture.path}: reference identity diverged`,
      )
      const [nativeSession, portableSession] = await Promise.all([
        sessions.read(native.refs[0]!),
        bundle.sessions.read(portableScan.refs[0]!),
      ])
      assert.equal(
        canonical(bundle.jsonOf(portableSession), store.root),
        canonical(bundle.jsonOf(nativeSession), store.root),
        `${fixture.path}: portable evidence diverged from the Node driver`,
      )
      compared += 1
    }
    assert(compared >= 50, `portable parity must cover the fixture corpus, compared ${compared}`)
  }
  finally {
    store.dispose()
  }
}
