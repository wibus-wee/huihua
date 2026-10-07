import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'

import type { Session } from '../../contracts/session.ts'
import { contentBlocks, jsonlProvider } from '../../shared/ingestion.ts'
import { array, object, optional, string, timestamp } from '../../shared/value.ts'

export const kimiProvider = jsonlProvider({
  id: 'kimi',
  roots(options) {
    const home = options.homeDir === undefined ? process.env.KIMI_CODE_HOME : undefined
    return options.roots?.kimi ?? [join(home ?? join(options.homeDir ?? homedir(), '.kimi-code'), 'sessions')]
  },
  accepts: path => basename(path) === 'wire.jsonl',
  metadataFiles(path) {
    return basename(dirname(dirname(path))) === 'agents' ? [join(dirname(dirname(dirname(path))), 'state.json')] : []
  },
  metadata(records, path, context) {
    let facts: Partial<Session> = {}
    for (const native of records) {
      const v = object(native)
      if (typeof v.id === 'string' && 'createdAt' in v && 'agents' in v) {
        facts = {
          ...optional('id', string(v.id)),
          ...optional('title', string(v.title)),
          ...optional('createdAt', timestamp(v.createdAt)),
          ...optional('updatedAt', timestamp(v.updatedAt)),
          ...optional('workspace', typeof (v.cwd ?? v.workDir) === 'string' ? { path: String(v.cwd ?? v.workDir) } : undefined),
          ...optional('parentSessionId', string(v.forkedFrom)),
          metadata: { ...facts.metadata, id_origin: 'native', nativeSessionId: v.id },
        }
      }
      else if (v.type === 'metadata') {
        facts = { ...facts, ...optional('createdAt', timestamp(v.created_at)), metadata: { ...facts.metadata, ...optional('protocol_version', v.protocol_version) } }
      }
    }
    const agentId = basename(dirname(path))
    return context.fileBacked && basename(dirname(dirname(path))) === 'agents'
      ? { ...facts, metadata: { ...facts.metadata, agentId, agentRole: agentId === 'main' ? 'main' : 'subagent' } }
      : facts
  },
  time: native => timestamp(object(native).time),
  parse(ingest, native) {
    const v = object(native)
    const type = string(v.type) ?? 'kimi_record'
    const envelope = { ...v, timestamp: v.time }
    if (type === 'context.append_message') {
      const m = object(v.message)
      if (m.role === 'user' || m.role === 'assistant') {
        for (const part of array(m.content)) {
          const p = object(part)
          if (p.type === 'think') {
            ingest.emit('reasoning', { ...optional('text', string(p.think)), ...optional('encrypted', p.encrypted) }, envelope)
          }
          else {
            const content = p.type === 'image_url'
              ? [{ type: 'image' as const, data: { ...optional('uri', string(object(p.imageUrl).url)), metadata: p } }]
              : contentBlocks(part)
            ingest.emit(m.role === 'user' ? 'user_message' : 'assistant_message', { content }, { ...envelope, id: m.id }, { message_origin: m.origin, partial: m.partial })
          }
        }
        for (const call of array(m.toolCalls)) {
          const c = object(call)
          if (typeof c.name === 'string')
            ingest.emit('tool_call', { ...optional('callId', string(c.id)), toolName: c.name, arguments: c.arguments ?? null }, envelope)
          else
            ingest.unknown('kimi_tool_call', call)
        }
        if ('usage' in m)
          ingest.emit('usage', { usage: m.usage }, envelope)
      }
      else if (m.role === 'tool') {
        ingest.emit('tool_result', { ...optional('callId', string(m.toolCallId)), ...optional('toolName', string(m.name)), result: m, isError: m.isError === true }, envelope)
      }
      else if (m.role === 'system') {
        ingest.emit('system', { sourceType: type, payload: native }, envelope)
      }
      else {
        ingest.unknown(type, native)
      }
    }
    else if (type === 'usage.record') {
      ingest.emit('usage', { usage: v.usage ?? null }, envelope, { model: v.model, usageScope: v.usageScope })
    }
    else if (['subagent.spawned', 'subagent.started', 'subagent.completed', 'subagent.failed'].includes(type) && typeof v.subagentId === 'string') {
      const kind = type === 'subagent.spawned' ? 'spawn' : type === 'subagent.started' ? 'started' : type === 'subagent.failed' ? 'failed' : 'completed'
      ingest.emit('subagent', { agentId: v.subagentId, ...optional('parentAgentId', string(v.parentAgentId) ?? string(v.callerAgentId)), kind, ...optional('name', string(v.subagentName)), metadata: v }, envelope)
    }
    else if (type === 'interaction.request' && v.kind === 'approval') {
      ingest.emit('permission_request', { ...optional('requestId', string(v.id)), request: native }, envelope)
    }
    else if (type === 'interaction.request' || type === 'interaction.resolved') {
      ingest.emit('system', { sourceType: type, payload: native }, envelope)
    }
    else if (type === 'metadata' || ('agents' in v && 'createdAt' in v) || ['turn.prompt', 'turn.steer', 'turn.begin', 'turn.end', 'turn.cancel', 'config.update', 'profile.bind', 'permission.set_mode', 'context.apply_compaction', 'context.undo', 'context.clear', 'forked', 'subagent.cancelled', 'llm.request', 'llm.tools_snapshot'].includes(type)) {
      ingest.emit('system', { sourceType: type, payload: native }, envelope)
      if (type === 'metadata' && typeof v.protocol_version === 'string' && !/^1\.[0-5]$/.test(v.protocol_version))
        ingest.diagnostic('UnsupportedSchema', `unsupported Kimi wire protocol ${v.protocol_version}`)
    }
    else {
      ingest.unknown(type, native)
    }
  },
})
