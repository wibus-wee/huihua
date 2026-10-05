import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import process from 'node:process'

import type { Session } from '../../contracts/session.ts'
import { jsonlProvider, messageEvents } from '../../shared/ingestion.ts'
import { object, optional, string, timestamp } from '../../shared/value.ts'

export const claudeProvider = jsonlProvider({
  id: 'claude',
  roots(options) {
    if (options.roots?.claude)
      return options.roots.claude
    const home = options.homeDir ?? homedir()
    const config
      = options.homeDir === undefined ? process.env.CLAUDE_CONFIG_DIR : undefined
    if (config !== undefined && config !== '') {
      return [
        basename(config) === 'projects' ? config : join(config, 'projects'),
      ]
    }
    const xdg
      = options.homeDir === undefined ? process.env.XDG_CONFIG_HOME : undefined
    return [
      join(home, '.claude/projects'),
      join(
        xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, '.config'),
        'claude/projects',
      ),
    ]
  },
  metadata(records) {
    const facts: Partial<Session> = {}
    let metadata: Record<string, unknown> = {}
    for (const record of records) {
      const v = object(record)
      const workspace = {
        ...optional('path', string(v.cwd)),
        ...optional('branch', string(v.gitBranch)),
      }
      if (Object.keys(workspace).length) {
        Object.assign(facts, {
          workspace: { ...facts.workspace, ...workspace },
        })
      }
      if (facts.createdAt === undefined && timestamp(v.timestamp))
        Object.assign(facts, { createdAt: timestamp(v.timestamp) })
      Object.assign(facts, {
        ...optional('id', string(v.sessionId)),
        ...optional('parentSessionId', string(v.parentSessionId)),
      })
      if (typeof v.sessionId === 'string')
        metadata = { ...metadata, id_origin: 'native' }
      if (v.type === 'custom-title')
        Object.assign(facts, optional('title', string(v.customTitle)))
    }
    return { ...facts, metadata }
  },
  parse(ingest, native) {
    const v = object(native)
    const type = string(v.type) ?? 'unknown'
    if (type === 'user' || type === 'assistant') {
      const m = object(v.message)
      if ('content' in m)
        messageEvents(ingest, type, m.content, string(m.model))
      if (type === 'assistant' && 'usage' in m)
        ingest.emit('usage', { usage: m.usage })
    }
    else if (['system', 'summary', 'custom-title'].includes(type)) {
      ingest.emit('system', { sourceType: type, payload: native })
    }
    else if (type === 'permission_request') {
      ingest.emit('permission_request', {
        ...optional('requestId', string(v.id)),
        request: native,
      })
    }
    else {
      ingest.unknown(type, native)
    }
  },
})
