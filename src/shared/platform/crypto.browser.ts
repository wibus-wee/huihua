import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/** Synchronous by contract: native hashing is async in a tab, and one call site must not change shape. */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}
