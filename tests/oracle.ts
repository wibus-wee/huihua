import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { ContentBlock, SessionEvent } from '../src/contracts/event.ts'
import type { Session } from '../src/contracts/session.ts'

export interface FixtureCase {
  provider: string
  path: string
  golden?: string
  snapshot?: string
}
export const fixtureRoot = resolve('fixtures')
export async function cases(): Promise<FixtureCase[]> {
  const lists = await Promise.all(['cases.json', 'provider-cases.json'].map(async path => JSON.parse(await readFile(resolve(fixtureRoot, path), 'utf8')) as FixtureCase[]))
  return lists.flat()
}
function clean(value: {
  id: unknown
  timestamp: unknown
  type: unknown
  data: unknown
}): unknown {
  const data = { ...(value.data as Record<string, unknown>) }
  const optionalFields: Record<string, readonly string[]> = {
    assistant_message: ['model'],
    reasoning: ['text', 'summary', 'encrypted'],
    tool_call: ['call_id'],
    tool_result: ['call_id', 'tool_name'],
    command: ['output', 'exit_code'],
    permission_request: ['request_id'],
    subagent: ['parent_agent_id', 'name'],
    file_change: ['before', 'after', 'diff'],
  }
  for (const field of optionalFields[String(value.type)] ?? []) {
    if (data[field] === null || data[field] === undefined)
      delete data[field]
  }
  if (Array.isArray(data.content)) {
    data.content = data.content.map((block: Record<string, unknown>) => {
      if (block.type !== 'image' && block.type !== 'file')
        return block
      const attachment = { ...(block.data as Record<string, unknown>) }
      for (const field of ['uri', 'mime_type', 'data']) {
        if (attachment[field] === null || attachment[field] === undefined)
          delete attachment[field]
      }
      return { ...block, data: attachment }
    })
  }
  // Native payloads, usage, arguments, results, metadata and Structured(null) are opaque.
  // Only absent optional canonical fields differ between historical nulls and current omission.
  return {
    ...(value.id == null ? {} : { id: value.id }),
    ...(value.timestamp == null ? {} : { timestamp: value.timestamp }),
    type: value.type,
    data,
  }
}
/** Only canonical fields are renamed; opaque native payloads retain their own schema. */
export function semantic(event: SessionEvent) {
  const d = event.data as unknown as Record<string, unknown>
  const data: Record<string, unknown> = {}
  const fields: Record<string, string> = {
    sourceType: 'source_type',
    callId: 'call_id',
    toolName: 'tool_name',
    isError: 'is_error',
    exitCode: 'exit_code',
    requestId: 'request_id',
    agentId: 'agent_id',
    parentAgentId: 'parent_agent_id',
  }
  for (const [key, value] of Object.entries(d)) {
    if (event.type === 'unknown' && key === 'payload') {
      data.payload = {
        format:
          event.data.sourceType === 'malformed_jsonl'
          && typeof value === 'string'
            ? 'text'
            : 'json',
        value,
      }
    }
    else if (event.type === 'error' && key === 'details') {
      data.error = value
    }
    else if (key === 'content' && Array.isArray(value)) {
      data.content = (value as ContentBlock[]).map((block) => {
        if (block.type === 'image' || block.type === 'file') {
          const { mimeType, ...rest } = block.data
          return {
            ...block,
            data: {
              ...rest,
              ...(mimeType === undefined ? {} : { mime_type: mimeType }),
            },
          }
        }
        return block
      })
    }
    else {
      data[fields[key] ?? key] = value
    }
  }
  return clean({
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    data,
  })
}
export function oracleSemantic(event: unknown) {
  const v = event as Record<string, unknown>
  return clean({
    id: v.id,
    timestamp: v.timestamp,
    type: v.type,
    data: v.data,
  })
}
export function stableSnapshot(session: Session): unknown {
  const data = JSON.parse(JSON.stringify(session)) as Session
  return JSON.parse(
    JSON.stringify(data).replaceAll(fixtureRoot, '<fixtures>'),
  ) as unknown
}
export function snapshotPath(fixture: FixtureCase): string {
  return resolve(
    fixtureRoot,
    fixture.snapshot ?? fixture.golden?.replace('.golden.json', '.ts.golden.json') ?? `${fixture.path}.ts.golden.json`,
  )
}
