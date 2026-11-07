import type { PathSeam } from './types.ts'

/** Split into segments, dropping empty and current-directory segments and retaining overflow parents. */
function segments(path: string): string[] {
  const output: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.')
      continue
    if (segment === '..' && output.length !== 0 && output.at(-1) !== '..') {
      output.pop()
      continue
    }
    output.push(segment)
  }
  return output
}
function normalized(path: string): string {
  const absolute = path.startsWith('/')
  const trailing = /\/$/.test(path) && path !== '/'
  const parts = segments(path)
  const joined = parts.join('/')
  if (absolute)
    return joined === '' ? '/' : `/${joined}`
  if (joined === '')
    return '.'
  return trailing ? `${joined}/` : joined
}
export const sep = '/'
export const delimiter = ':'
export function isAbsolute(path: string): boolean {
  return path.startsWith('/')
}
/** No current working directory exists here: the platform root is the base for relative input. */
export function resolve(...parts: string[]): string {
  let resolved = ''
  let absolute = false
  for (let index = parts.length - 1; index >= 0 && !absolute; index--) {
    const part = parts[index]!
    if (part === '')
      continue
    resolved = `${part}/${resolved}`
    absolute = part.startsWith('/')
  }
  return normalized(absolute ? resolved : `/${resolved}`)
}
export function join(...parts: string[]): string {
  const present = parts.filter(part => part !== '')
  if (present.length === 0)
    return '.'
  const joined = normalized(present.join('/'))
  // Node keeps a trailing separator only when the last supplied segment ends with one.
  const trailing = present.at(-1)!.endsWith('/')
  return trailing && joined !== '/' ? `${joined}/` : joined
}
export function relative(from: string, to: string): string {
  if (from === to)
    return ''
  const origin = segments(resolve(from))
  const target = segments(resolve(to))
  let shared = 0
  while (shared < origin.length && shared < target.length && origin[shared] === target[shared])
    shared++
  const output: string[] = []
  for (let index = shared; index < origin.length; index++)
    output.push('..')
  output.push(...target.slice(shared))
  return output.join('/')
}
/** Node semantics: the parent of the raw final segment; parents are removed, not normalized. */
export function dirname(path: string): string {
  if (path === '')
    return '.'
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed === '')
    return '/'
  const separator = trimmed.lastIndexOf('/')
  if (separator === -1)
    return '.'
  if (separator === 0)
    return '/'
  return trimmed.slice(0, separator)
}
/** Node semantics: the raw final segment, never normalized, and a suffix is removed only when something remains. */
export function basename(path: string, suffix?: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const separator = trimmed.lastIndexOf('/')
  const name = separator === -1 ? trimmed : trimmed.slice(separator + 1)
  if (suffix === undefined || suffix === '' || name === suffix || !name.endsWith(suffix))
    return name
  return name.slice(0, -suffix.length)
}
export const path: PathSeam = {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
}
