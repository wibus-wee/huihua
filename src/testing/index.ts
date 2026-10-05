import type { Session } from '../contracts/session.ts'
/** Shared provider invariants without a dependency on any test runner. Throws on a broken SPI. */
export function assertSessionContract(session: Session): void {
  const records = new Map(
    session.records.map(record => [record.sequence, record]),
  )
  if (records.size !== session.records.length)
    throw new Error('duplicate evidence sequence')
  for (const [index, record] of session.records.entries()) {
    if (record.sequence !== index || record.provider !== session.provider)
      throw new Error('unstable native record sequence or provider')
  }
  for (const [index, event] of session.events.entries()) {
    if (event.sequence !== index || !records.has(event.record))
      throw new Error('unstable event sequence or unreachable evidence')
  }
  const referenced = new Set(session.events.map(event => event.record))
  for (const record of session.records) {
    if (!referenced.has(record.sequence))
      throw new Error('native record silently dropped')
  }
}
