import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { PathSeam } from './types.ts'

export { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep }

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
