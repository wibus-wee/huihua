import { Buffer as Portable } from 'buffer/index.js'

type BufferConstructor = typeof import('node:buffer').Buffer

/**
 * The maintained pure-JS implementation, exposed with the Node type so both arms share one
 * declaration. A host that already provides the global keeps it, so one class serves every library
 * that expects it (XXH64 allocates its scratch buffer that way).
 */
const existing = Reflect.get(globalThis, 'Buffer') as BufferConstructor | undefined
if (existing === undefined)
  Reflect.set(globalThis, 'Buffer', Portable)
export const Buffer: BufferConstructor = existing ?? (Portable as unknown as BufferConstructor)
