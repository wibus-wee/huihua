import type { Timestamp } from '../contracts/event.ts'

export function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
export function timestamp(value: unknown): Timestamp | undefined {
  if (typeof value === 'string')
    return { format: 'rfc3339', value }
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return { format: 'unix_millis', value }
  return undefined
}
export function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}
export function parseNative(text: string): unknown {
  return JSON.parse(text) as unknown
}
export function jsonOf(value: unknown): string {
  return JSON.stringify(value)
}
