import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { SessionError } from '../contracts/diagnostic.ts'
import type { ScanEvent, ScanOptions } from '../contracts/provider.ts'
import { positiveLimit, scanFailure } from '../contracts/provider.ts'

export { positiveLimit }

export function ioErrorOf(error: unknown, path: string): SessionError {
  if (error instanceof SessionError)
    return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return new SessionError(
    code === 'EACCES' || code === 'EPERM'
      ? 'PermissionDenied'
      : code === 'ENOENT'
        ? 'SessionNotFound'
        : 'IOError',
    `${path}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  )
}
export function ioError(error: unknown, path: string): never {
  throw ioErrorOf(error, path)
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
/**
 * Never recurse through symlinks; explicit symlink roots are allowed.
 * Supplying scan options and a provider reports traversal failures; read-side traversal throws.
 */
export function files(roots: readonly string[], accepts: (path: string) => boolean, signal?: AbortSignal): AsyncGenerator<string>
export function files(roots: readonly string[], accepts: (path: string) => boolean, options: ScanOptions, provider: string): AsyncGenerator<string | Extract<ScanEvent, { type: 'failure' }>>
export async function* files(
  roots: readonly string[],
  accepts: (path: string) => boolean,
  input?: AbortSignal | ScanOptions,
  provider?: string,
): AsyncGenerator<string | Extract<ScanEvent, { type: 'failure' }>> {
  const options: ScanOptions = input && 'throwIfAborted' in input ? { signal: input } : input ?? {}
  const signal = options.signal
  signal?.throwIfAborted()
  if (provider !== undefined)
    positiveLimit(options.headerBytes, 65536)
  const seen = new Set<string>()
  async function* visit(path: string): AsyncGenerator<string | Extract<ScanEvent, { type: 'failure' }>> {
    signal?.throwIfAborted()
    let info
    try {
      info = await stat(path)
    }
    catch (error) {
      signal?.throwIfAborted()
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT')
        return
      if (provider === undefined)
        ioError(error, path)
      yield { type: 'failure', failure: scanFailure(provider, ioErrorOf(error, path), { path }) }
      return
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
      signal?.throwIfAborted()
      if (provider === undefined)
        ioError(error, path)
      yield { type: 'failure', failure: scanFailure(provider, ioErrorOf(error, path), { path }) }
      return
    }
    for (const entry of entries.sort((a, b) =>
      a.name.localeCompare(b.name, 'en'))) {
      if (entry.isDirectory() || entry.isFile())
        yield* visit(join(path, entry.name))
    }
  }
  for (const root of roots) yield* visit(resolve(root))
}
