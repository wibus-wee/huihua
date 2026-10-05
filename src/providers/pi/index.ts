import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import type { Session } from '../../contracts/session.ts'
import { jsonlProvider, messageEvents } from '../../shared/ingestion.ts'
import { object, optional, string, timestamp } from '../../shared/value.ts'

export const piProvider = jsonlProvider({
  id: 'pi',
  roots(options) {
    const root
      = options.homeDir === undefined
        ? process.env.PI_CODING_AGENT_DIR
        : undefined
    return (
      options.roots?.pi ?? [
        join(
          root ?? join(options.homeDir ?? homedir(), '.pi/agent'),
          'sessions',
        ),
      ]
    )
  },
  metadata(records) {
    let facts: Partial<Session> = {}
    const metadata: Record<string, unknown> = {}
    for (const record of records) {
      const v = object(record)
      if (v.type === 'session') {
        facts = {}
        Object.assign(facts, {
          ...optional('id', string(v.id)),
          ...optional('createdAt', timestamp(v.timestamp)),
          ...optional(
            'workspace',
            typeof v.cwd === 'string' ? { path: v.cwd } : undefined,
          ),
        })
        for (const key of ['version', 'parentSession']) {
          if (key in v)
            metadata[key] = v[key]
        }
        if (typeof v.id === 'string')
          metadata.id_origin = 'native'
      }
      if (v.type === 'session_info')
        Object.assign(facts, optional('title', string(v.name)))
    }
    return { ...facts, metadata }
  },
  parse(ingest, native) {
    const v = object(native)
    const type = string(v.type) ?? 'unknown'
    if (
      [
        'session',
        'session_info',
        'model_change',
        'thinking_level_change',
        'compaction',
        'branch_summary',
        'label',
      ].includes(type)
    ) {
      ingest.emit('system', { sourceType: type, payload: native })
      if (type === 'session' && typeof v.version === 'number' && v.version > 3) {
        ingest.diagnostic(
          'UnsupportedSchema',
          `unsupported Pi session version ${v.version}`,
        )
      }
    }
    else if (type === 'message') {
      const m = object(v.message)
      const role = string(m.role)
      if (role === 'user' || role === 'assistant') {
        if ('content' in m)
          messageEvents(ingest, role, m.content, string(m.model))
        if ('usage' in m)
          ingest.emit('usage', { usage: m.usage })
      }
      else if (role === 'toolResult') {
        ingest.emit('tool_result', {
          ...optional('callId', string(m.toolCallId)),
          ...optional('toolName', string(m.toolName)),
          result: m,
          isError: m.isError === true,
        })
      }
      else if (role === 'bashExecution') {
        ingest.emit('command', {
          command: m.command ?? null,
          ...optional('output', m.output),
          ...optional(
            'exitCode',
            typeof m.exitCode === 'number' ? m.exitCode : undefined,
          ),
        })
      }
      else {
        ingest.unknown('message', native)
      }
    }
    else {
      ingest.unknown(type, native)
    }
  },
})
