import { mountTree, segmentsOf, unmountTree } from '../shared/platform/mount.ts'

/** One handed-over file: the browser can read it, and nothing else is known about it yet. */
export interface PortableEntry {
  readonly path: string
  readonly blob: Blob
}
export interface MountOptions {
  /** Force the placement instead of inferring it from the handed-over shape. */
  readonly as?: 'home' | 'files'
}
export interface PortableStore {
  /** Synthetic root of this mount; every mounted path starts with it. */
  readonly root: string
  /** Synthetic home for home-shaped hand-offs; scan with it so provider defaults resolve inside it. */
  readonly homeDir: string | undefined
  readonly mode: 'home' | 'files'
  readonly paths: readonly string[]
  readonly files: number
  readonly bytes: number
  /** Map an evidence path back to what the caller handed over. */
  describe: (path: string) => string | undefined
  dispose: () => void
}
let mounted = 0

/**
 * Place handed-over entries in one read-only virtual tree.
 * Nothing is copied: reads slice the original blobs, so the mount never materializes the store.
 */
export function mount(entries: Iterable<PortableEntry>, options: MountOptions = {}): PortableStore {
  const incoming = [...entries]
  if (incoming.length === 0)
    throw new TypeError('mount requires at least one entry')
  const nested = incoming.every(entry => segmentsOf(entry.path).length > 1)
  const mode = options.as ?? (nested ? 'home' : 'files')
  mounted += 1
  const root = mode === 'home' ? `/huihua/${mounted}/home` : `/huihua/${mounted}/files`
  const described = new Map<string, string>()
  let bytes = 0
  const paths: string[] = []
  mountTree(root, incoming.map((entry) => {
    const relative = segmentsOf(entry.path).join('/')
    const path = `${root}/${relative}`
    described.set(path, relative)
    bytes += entry.blob.size
    paths.push(path)
    return { path: relative, blob: entry.blob }
  }))
  return {
    root,
    homeDir: mode === 'home' ? root : undefined,
    mode,
    paths,
    files: incoming.length,
    bytes,
    describe: path => described.get(path),
    dispose: () => unmountTree(root),
  }
}
/** The same file set as explicit roots for every provider; certification stays provider-owned. */
export function rootsFor(
  providers: Iterable<{ readonly id: string }>,
  paths: readonly string[],
): Record<string, readonly string[]> {
  const roots: Record<string, readonly string[]> = {}
  for (const provider of providers)
    roots[provider.id] = [...paths]
  return roots
}
