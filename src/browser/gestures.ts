import type { PortableEntry } from './mount.ts'

/** Structural views of the handful of browser inputs that can hand over files; no DOM globals are touched. */
export interface BrowserFile extends Blob {
  readonly name: string
  readonly webkitRelativePath?: string
}
export interface DropEntry {
  readonly name: string
  readonly isFile: boolean
  readonly isDirectory: boolean
  file: (success: (file: Blob | null) => void, failure?: (reason: unknown) => void) => void
  createReader?: () => DropReader
}
export interface DropReader {
  readEntries: (success: (entries: DropEntry[]) => void, failure?: (reason: unknown) => void) => void
}
export interface DropItem {
  readonly webkitGetAsEntry?: () => DropEntry | null
  readonly getAsFile?: () => File | null
}
export interface DropData {
  readonly items: Iterable<DropItem>
}
export interface DirectoryHandleLike {
  readonly name: string
  values: () => AsyncIterable<DirectoryEntryHandleLike>
}
export interface DirectoryEntryHandleLike {
  readonly kind: 'file' | 'directory'
  readonly name: string
  getFile: () => Promise<File>
  values?: () => AsyncIterable<DirectoryEntryHandleLike>
}

/** `<input type="file">` and `webkitdirectory`; the relative path preserves the picked tree. */
export function entriesFromFileList(files: Iterable<BrowserFile>): readonly PortableEntry[] {
  return Array.from(files, file => ({
    path: (file.webkitRelativePath !== undefined && file.webkitRelativePath !== '' ? file.webkitRelativePath : file.name),
    blob: file,
  }))
}
async function readAll(reader: DropReader): Promise<DropEntry[]> {
  return new Promise<DropEntry[]>((resolve, reject) => {
    const entries: DropEntry[] = []
    const next = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries)
          return
        }
        entries.push(...batch)
        next()
      }, reject)
    }
    next()
  })
}
async function fileOf(entry: DropEntry): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    entry.file((file) => {
      if (file === null) {
        reject(new Error(`unreadable entry: ${entry.name}`))
        return
      }
      resolve(file)
    }, reject)
  })
}
async function walkEntry(entry: DropEntry, prefix: string, output: PortableEntry[]): Promise<void> {
  const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
  if (entry.isFile) {
    output.push({ path, blob: await fileOf(entry) })
    return
  }
  if (!entry.isDirectory || entry.createReader === undefined)
    return
  const children = await readAll(entry.createReader())
  for (const child of children)
    await walkEntry(child, path, output)
}
/** Drag and drop, including a whole folder: dot directories survive because no picker filters them. */
export async function entriesFromDrop(data: DropData): Promise<readonly PortableEntry[]> {
  const output: PortableEntry[] = []
  for (const item of data.items) {
    const entry = item.webkitGetAsEntry?.() ?? null
    if (entry !== null) {
      await walkEntry(entry, '', output)
      continue
    }
    const file = item.getAsFile?.() ?? null
    if (file !== null)
      output.push({ path: file.name, blob: file })
  }
  return output
}
async function walkHandle(handle: DirectoryEntryHandleLike, prefix: string, output: PortableEntry[]): Promise<void> {
  if (handle.kind === 'file') {
    output.push({ path: prefix === '' ? handle.name : `${prefix}/${handle.name}`, blob: await handle.getFile() })
    return
  }
  const children = handle.values?.()
  if (children === undefined)
    return
  const path = prefix === '' ? handle.name : `${prefix}/${handle.name}`
  for await (const child of children)
    await walkHandle(child, path, output)
}
/** File System Access API: the same directory can be re-attached later without picking it again. */
export async function entriesFromDirectory(directory: DirectoryHandleLike): Promise<readonly PortableEntry[]> {
  const output: PortableEntry[] = []
  for await (const child of directory.values())
    await walkHandle(child, '', output)
  return output
}
