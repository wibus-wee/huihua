import { sessions } from '../index.ts'
import { rootsFor } from './mount.ts'

export * from '../index.ts'
export type { BrowserFile, DirectoryEntryHandleLike, DirectoryHandleLike, DropData, DropEntry, DropItem, DropReader } from './gestures.ts'
export { entriesFromDirectory, entriesFromDrop, entriesFromFileList } from './gestures.ts'
export type { MountOptions, PortableEntry, PortableStore } from './mount.ts'
export { mount, rootsFor } from './mount.ts'

/** Every mounted file as an explicit root for every registered provider; certification stays provider-owned. */
export function allProviderRoots(paths: readonly string[]): Record<string, readonly string[]> {
  return rootsFor(sessions.providers(), paths)
}
