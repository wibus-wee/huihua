/**
 * Read-only mount table for handed-over entries: a virtual POSIX tree over a platform-free Blob.
 * Discovery, providers and sockets see ordinary absolute paths; nothing here parses session data.
 */
export interface MountedEntry {
  readonly path: string
  readonly blob: Blob
}
interface MountedDirectory {
  readonly directories: ReadonlyMap<string, MountedDirectory>
  readonly files: ReadonlyMap<string, Blob>
}
export type MountedNode
  = | { readonly kind: 'file', readonly blob: Blob }
    | { readonly kind: 'directory', readonly directory: MountedDirectory }

interface MutableDirectory {
  readonly directories: Map<string, MutableDirectory>
  readonly files: Map<string, Blob>
}
const mounts = new Map<string, MutableDirectory>()

/** Entry paths are relative and portable: no drive letters, no parent traversals, no empty segments. */
export function segmentsOf(path: string): string[] {
  const output: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.')
      continue
    if (segment === '..')
      throw new TypeError(`entry paths must not traverse upward: ${path}`)
    output.push(segment)
  }
  if (output.length === 0)
    throw new TypeError(`entry path must name a file: ${path}`)
  return output
}
export function mountTree(root: string, entries: Iterable<MountedEntry>): void {
  const tree: MutableDirectory = { directories: new Map(), files: new Map() }
  for (const entry of entries) {
    const segments = segmentsOf(entry.path)
    const name = segments.pop()!
    let directory = tree
    for (const segment of segments) {
      const existing = directory.directories.get(segment)
      if (existing === undefined) {
        const created: MutableDirectory = { directories: new Map(), files: new Map() }
        directory.directories.set(segment, created)
        directory = created
        continue
      }
      directory = existing
    }
    directory.files.set(name, entry.blob)
  }
  mounts.set(root, tree)
}
export function unmountTree(root: string): void {
  mounts.delete(root)
}
function normalize(path: string): string {
  const output: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.')
      continue
    if (segment === '..') {
      output.pop()
      continue
    }
    output.push(segment)
  }
  return `/${output.join('/')}`
}
function deepestMount(path: string): { root: string, rest: string[] } | undefined {
  const segments = normalize(path).split('/').filter(segment => segment !== '')
  let best: { root: string, depth: number } | undefined
  for (const root of mounts.keys()) {
    const rootSegments = root.split('/').filter(segment => segment !== '')
    if (rootSegments.length > segments.length)
      continue
    if (!rootSegments.every((segment, index) => segments[index] === segment))
      continue
    if (best === undefined || rootSegments.length > best.depth)
      best = { root, depth: rootSegments.length }
  }
  return best === undefined ? undefined : { root: best.root, rest: segments.slice(best.depth) }
}
export function lookup(path: string): MountedNode | undefined {
  const located = deepestMount(path)
  if (located === undefined)
    return
  let directory = mounts.get(located.root)!
  for (const segment of located.rest.slice(0, -1)) {
    const next = directory.directories.get(segment)
    if (next === undefined)
      return
    directory = next
  }
  const name = located.rest.at(-1)
  if (name === undefined)
    return { kind: 'directory', directory }
  const file = directory.files.get(name)
  if (file !== undefined)
    return { kind: 'file', blob: file }
  const child = directory.directories.get(name)
  return child === undefined ? undefined : { kind: 'directory', directory: child }
}
/** Directories a caller may list without an existence probe; used by diagnostics and tests. */
export function mountedRoots(): readonly string[] {
  return [...mounts.keys()]
}
