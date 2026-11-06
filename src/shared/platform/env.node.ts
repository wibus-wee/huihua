import process from 'node:process'

/** The live process environment: providers read it at call time, never at import time. */
export const env: Readonly<Record<string, string | undefined>> = process.env
