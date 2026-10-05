import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { SessionError } from '../contracts/diagnostic.ts'

export function ioError(error: unknown, path: string): never {
  if (error instanceof SessionError)
    throw error
  const code = (error as NodeJS.ErrnoException).code
  throw new SessionError(
    code === 'EACCES' || code === 'EPERM'
      ? 'PermissionDenied'
      : code === 'ENOENT'
        ? 'SessionNotFound'
        : 'IOError',
    `${path}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  )
}
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return false
    ioError(error, path)
  }
}
/** Never follow store symlinks recursively; an explicitly supplied symlink root is allowed. */
export async function* files(
  roots: readonly string[],
  accepts: (path: string) => boolean,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const seen = new Set<string>()
  async function* visit(path: string): AsyncGenerator<string> {
    signal?.throwIfAborted()
    if (!(await exists(path)))
      return
    let info
    try {
      info = await stat(path)
    }
    catch (error) {
      ioError(error, path)
    }
    if (info.isFile()) {
      if (accepts(path) && !seen.has(path)) {
        seen.add(path)
        yield path
      }
      return
    }
    if (!info.isDirectory())
      return
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    }
    catch (error) {
      ioError(error, path)
    }
    for (const entry of entries.sort((a, b) =>
      a.name.localeCompare(b.name, 'en'))) {
      if (entry.isDirectory() || entry.isFile())
        yield* visit(join(path, entry.name))
    }
  }
  for (const root of roots) yield* visit(resolve(root))
}
export function positiveLimit(
  value: number | undefined,
  fallback: number,
): number {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new RangeError('resource limits must be positive safe integers')
  return limit
}
