/**
 * Platform seam contracts: the only platform facts a provider may depend on.
 * Node and browser arms implement these shapes; mapping, decoding and evidence never branch on platform.
 */
export interface StatFacts {
  readonly size: number
  readonly isFile: boolean
  readonly isDirectory: boolean
}
/** Change detection only: a virtual store derives these from the handed-over entry, not from an inode. */
interface StatIdentity {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}
export interface DirectoryEntry {
  readonly name: string
  isFile: () => boolean
  isDirectory: () => boolean
}
interface ReadResult {
  readonly bytesRead: number
}
/** The used subset of a read-only file handle; callers never write. */
export interface ReadHandle {
  read: (target: Uint8Array, offset: number, length: number, position: number) => Promise<ReadResult>
  stat: () => Promise<StatFacts>
  close: () => Promise<void>
}
export interface ReadStreamOptions {
  readonly highWaterMark: number
  readonly signal?: AbortSignal
}
export interface FileSystemSeam {
  stat: (path: string) => Promise<StatFacts>
  identity: (path: string) => Promise<StatIdentity>
  readdir: (path: string) => Promise<readonly DirectoryEntry[]>
  realpath: (path: string) => Promise<string>
  /** A pathname whose every component is a real directory, never a symbolic link. */
  canonical: (path: string) => Promise<boolean>
  open: (path: string) => Promise<ReadHandle>
  readStream: (path: string, options: ReadStreamOptions) => AsyncIterable<Uint8Array>
}
export interface PathSeam {
  basename: (path: string, suffix?: string) => string
  readonly delimiter: string
  dirname: (path: string) => string
  isAbsolute: (path: string) => boolean
  join: (...parts: string[]) => string
  relative: (from: string, to: string) => string
  resolve: (...parts: string[]) => string
  readonly sep: string
}
