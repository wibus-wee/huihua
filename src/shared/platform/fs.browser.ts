import { lookup } from './mount.ts'
import type { DirectoryEntry, FileSystemSeam, ReadHandle, ReadStreamOptions, StatFacts } from './types.ts'

interface CodedError extends Error {
  readonly code: string
}
function coded(code: string, message: string): CodedError {
  return Object.assign(new Error(message), { code })
}
function absent(path: string): CodedError {
  return coded('ENOENT', `ENOENT: no such entry, '${path}'`)
}
function factsOf(path: string): StatFacts {
  const node = lookup(path)
  if (node === undefined)
    throw absent(path)
  return node.kind === 'file'
    ? { size: node.blob.size, isFile: true, isDirectory: false }
    : { size: 0, isFile: false, isDirectory: true }
}
/** Handed-over entries carry a modification time when the gesture could supply one; otherwise it is absent. */
function modifiedAt(blob: Blob): bigint {
  const modified = 'lastModified' in blob && typeof blob.lastModified === 'number' ? blob.lastModified : 0
  return BigInt(Math.trunc(modified)) * 1_000_000n
}
function entry(name: string, kind: 'file' | 'directory'): DirectoryEntry {
  return { name, isFile: () => kind === 'file', isDirectory: () => kind === 'directory' }
}
export const fs: FileSystemSeam = {
  async stat(path) {
    return factsOf(path)
  },
  async identity(path) {
    const node = lookup(path)
    if (node === undefined)
      throw absent(path)
    const size = node.kind === 'file' ? node.blob.size : 0
    const modified = node.kind === 'file' ? modifiedAt(node.blob) : 0n
    return { dev: 0, ino: 0, size, mtimeNs: modified, ctimeNs: modified }
  },
  async readdir(path) {
    const node = lookup(path)
    if (node === undefined)
      throw absent(path)
    if (node.kind === 'file')
      throw coded('ENOTDIR', `ENOTDIR: not a directory, '${path}'`)
    return [
      ...Array.from(node.directory.directories.keys(), name => entry(name, 'directory')),
      ...Array.from(node.directory.files.keys(), name => entry(name, 'file')),
    ]
  },
  realpath: async path => path,
  canonical: async path => lookup(path) !== undefined,
  async open(path): Promise<ReadHandle> {
    const node = lookup(path)
    if (node === undefined)
      throw absent(path)
    if (node.kind !== 'file')
      throw coded('EISDIR', `EISDIR: illegal operation on a directory, '${path}'`)
    const { blob } = node
    return {
      async read(target, offset, length, position) {
        if (position >= blob.size || length === 0)
          return { bytesRead: 0 }
        const end = Math.min(blob.size, position + length)
        const slice = new Uint8Array(await blob.slice(position, end).arrayBuffer())
        target.set(slice, offset)
        return { bytesRead: slice.byteLength }
      },
      async stat() {
        return { size: blob.size, isFile: true, isDirectory: false }
      },
      async close() {},
    }
  },
  async* readStream(path: string, options: ReadStreamOptions) {
    const node = lookup(path)
    if (node === undefined)
      throw absent(path)
    if (node.kind !== 'file')
      throw coded('EISDIR', `EISDIR: illegal operation on a directory, '${path}'`)
    const { blob } = node
    for (let position = 0; position < blob.size; position += options.highWaterMark) {
      options.signal?.throwIfAborted()
      const end = Math.min(blob.size, position + options.highWaterMark)
      yield new Uint8Array(await blob.slice(position, end).arrayBuffer())
    }
  },
}
