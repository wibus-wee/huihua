import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import picomatch from 'picomatch'

import { SessionError } from '../contracts/diagnostic.ts'
import type { ScanEvent, ScanOptions } from '../contracts/provider.ts'
import { positiveLimit, scanFailure } from '../contracts/provider.ts'

export { positiveLimit }

/** Match a native pathname against fixed provider globs, optionally within a scan root. */
export function pathMatcher(patterns: string | readonly string[]): (path: string, root?: string) => boolean {
  const matches = picomatch(typeof patterns === 'string' ? patterns : [...patterns], { dot: true, windows: false })
  return (path, root) => {
    const candidate = root === undefined ? path : relative(root, path)
    if (root !== undefined && (isAbsolute(candidate) || candidate === '..' || candidate.startsWith(`..${sep}`)))
      return false
    // Normalize native separators only: a backslash is a legal filename character on POSIX.
    return matches(sep === '/' ? candidate : candidate.split(sep).join('/'))
  }
}

/** A canonical pathname rejects symbolic links in the file and its ancestors. */
export async function canonicalPath(path: string): Promise<boolean> {
  try {
    const absolute = resolve(path)
    const canonical = await realpath(path)
    return canonical === absolute
      || (process.platform === 'darwin' && ['/tmp', '/var'].some(alias => absolute.startsWith(`${alias}/`) && canonical === `/private${absolute}`))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return false
    ioError(error, path)
  }
}

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
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
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
