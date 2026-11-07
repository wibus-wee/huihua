import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { it } from 'node:test'

import { Buffer } from '#bytes'

import { entriesFromDirectory, entriesFromDrop, entriesFromFileList } from '../src/browser/gestures.ts'
import type { PortableEntry } from '../src/browser/mount.ts'
import { mount } from '../src/browser/mount.ts'
import { fs } from '../src/shared/platform/fs.browser.ts'
import { mountedRoots, mountTree, unmountTree } from '../src/shared/platform/mount.ts'
import * as portablePath from '../src/shared/platform/path.browser.ts'

function blob(text: string): Blob {
  return new File([text], 'entry')
}
function entry(path: string, text = '{}'): PortableEntry {
  return { path, blob: blob(text) }
}
async function textOf(source: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
}

void it('mount infers a synthetic home for nested hand-offs and keeps every path addressable', () => {
  const store = mount([entry('.claude/projects/slug/session.jsonl'), entry('.codex/sessions/2026/rollout-1.jsonl')])
  try {
    assert.equal(store.mode, 'home')
    assert.equal(store.homeDir, store.root)
    assert.ok(store.root.startsWith('/huihua/'))
    assert.equal(store.files, 2)
    assert.deepEqual(store.paths, [
      `${store.root}/.claude/projects/slug/session.jsonl`,
      `${store.root}/.codex/sessions/2026/rollout-1.jsonl`,
    ])
    assert.equal(store.describe(`${store.root}/.claude/projects/slug/session.jsonl`), '.claude/projects/slug/session.jsonl')
    assert.equal(store.describe('/somewhere/else.jsonl'), undefined)
  }
  finally {
    store.dispose()
  }
})

void it('mount uses explicit files for flat hand-offs and rejects traversals', () => {
  const store = mount([entry('rollout.jsonl'), entry('state.vscdb')])
  try {
    assert.equal(store.mode, 'files')
    assert.equal(store.homeDir, undefined)
    assert.deepEqual(store.paths, [`${store.root}/rollout.jsonl`, `${store.root}/state.vscdb`])
  }
  finally {
    store.dispose()
  }
  const forced = mount([entry('a/b.jsonl')], { as: 'files' })
  try {
    assert.equal(forced.homeDir, undefined)
    assert.deepEqual(forced.paths, [`${forced.root}/a/b.jsonl`])
  }
  finally {
    forced.dispose()
  }
  assert.throws(() => mount([entry('../escape.jsonl')]), TypeError)
  assert.throws(() => mount([]), TypeError)
})

void it('disposing a mount removes it from the table without touching other mounts', () => {
  const first = mount([entry('a.jsonl')], { as: 'files' })
  const second = mount([entry('b.jsonl')], { as: 'files' })
  first.dispose()
  assert.ok(!mountedRoots().includes(first.root))
  assert.ok(mountedRoots().includes(second.root))
  second.dispose()
})

void it('the portable filesystem serves stat, readdir, streaming and random access reads', async () => {
  mountTree('/fixture', [
    { path: 'projects/one.jsonl', blob: blob('{"a":1}\n{"b":2}\n') },
    { path: 'projects/nested/two.jsonl', blob: blob('{}') },
  ])
  try {
    assert.deepEqual(await fs.stat('/fixture/projects'), { size: 0, isFile: false, isDirectory: true })
    const listed = await fs.readdir('/fixture/projects')
    assert.deepEqual(listed.map(item => [item.name, item.isDirectory()]), [['nested', true], ['one.jsonl', false]])
    assert.equal((await fs.stat('/fixture/projects/one.jsonl')).size, 16)
    assert.equal(await textOf(fs.readStream('/fixture/projects/one.jsonl', { highWaterMark: 4 })), '{"a":1}\n{"b":2}\n')
    const handle = await fs.open('/fixture/projects/one.jsonl')
    assert.equal((await handle.stat()).size, 16)
    const target = new Uint8Array(5)
    assert.equal((await handle.read(target, 0, 5, 6)).bytesRead, 5)
    assert.equal(new TextDecoder().decode(target), '}\n{"b')
    await handle.close()
    assert.equal(await fs.realpath('/fixture/projects/./one.jsonl'), '/fixture/projects/./one.jsonl')
    assert.equal(await fs.canonical('/fixture/projects/one.jsonl'), true)
    assert.equal(await fs.canonical('/fixture/missing.jsonl'), false)
    const identity = await fs.identity('/fixture/projects/one.jsonl')
    assert.equal(identity.size, 16)
    await assert.rejects(fs.stat('/fixture/missing.jsonl'), error => (error as { code?: string }).code === 'ENOENT')
    await assert.rejects(fs.readdir('/fixture/projects/one.jsonl'), error => (error as { code?: string }).code === 'ENOTDIR')
    await assert.rejects(fs.open('/fixture/projects'), error => (error as { code?: string }).code === 'EISDIR')
  }
  finally {
    unmountTree('/fixture')
  }
})

void it('the portable path arm matches node:path for every provider-facing operation', () => {
  const inputs = ['/', '/a', '/a/', '/a/b', '/a/b/..', '/a//b', '.', '..', './a', 'a/b', '/a/b.jsonl', 'projects/x/1.jsonl']
  for (const value of inputs) {
    assert.equal(portablePath.basename(value), posix.basename(value), `basename ${value}`)
    assert.equal(portablePath.basename(value, '.jsonl'), posix.basename(value, '.jsonl'), `basename suffix ${value}`)
    assert.equal(portablePath.dirname(value), posix.dirname(value), `dirname ${value}`)
    assert.equal(portablePath.isAbsolute(value), posix.isAbsolute(value), `isAbsolute ${value}`)
    assert.equal(portablePath.join(value, 'child'), posix.join(value, 'child'), `join ${value}`)
    assert.equal(portablePath.join('/root', value), posix.join('/root', value), `join root ${value}`)
    // Absolute input only: a tab has no working directory, so relative input resolves from the root.
    if (!value.startsWith('/'))
      continue
    assert.equal(portablePath.resolve(value), posix.resolve(value), `resolve ${value}`)
    for (const other of inputs.filter(candidate => candidate.startsWith('/')))
      assert.equal(portablePath.relative(value, other), posix.relative(value, other), `relative ${value} ${other}`)
  }
  assert.equal(portablePath.sep, '/')
  assert.equal(portablePath.delimiter, ':')
  assert.equal(portablePath.resolve('/mount', 'a', '..', 'b'), '/mount/b')
})

void it('gesture adapters preserve relative paths from a file list, a drop and a directory handle', async () => {
  const listed = entriesFromFileList([
    Object.assign(new File(['{}'], 'x.jsonl'), { webkitRelativePath: '.claude/projects/x/x.jsonl' }),
    new File(['{}'], 'loose.jsonl'),
  ])
  assert.deepEqual(listed.map(item => item.path), ['.claude/projects/x/x.jsonl', 'loose.jsonl'])

  const fileEntry = (name: string, text: string) => ({
    name,
    isFile: true,
    isDirectory: false,
    file: (success: (file: Blob | null) => void) => success(new File([text], name)),
  })
  const directoryEntry = (name: string, children: ReturnType<typeof fileEntry>[]) => ({
    name,
    isFile: false,
    isDirectory: true,
    file: (success: (file: Blob | null) => void) => success(null),
    createReader: () => {
      let served = false
      return {
        readEntries: (success: (entries: typeof children) => void) => {
          const batch = served ? [] : children
          served = true
          success(batch)
        },
      }
    },
  })
  const dropped = await entriesFromDrop({
    items: [{ webkitGetAsEntry: () => directoryEntry('.claude', [fileEntry('id.jsonl', '{}')]) }],
  })
  assert.deepEqual(dropped.map(item => item.path), ['.claude/id.jsonl'])

  const walked = await entriesFromDirectory({
    name: 'home',
    values: () => (async function* values() {
      yield {
        kind: 'directory' as const,
        name: '.codex',
        getFile: async () => Promise.reject(new Error('not a file')),
        values: () => (async function* nested() {
          yield { kind: 'file' as const, name: 'rollout.jsonl', getFile: async () => Promise.resolve(new File(['{}'], 'rollout.jsonl')) }
        })(),
      }
    })(),
  })
  assert.deepEqual(walked.map(item => item.path), ['.codex/rollout.jsonl'])
})
