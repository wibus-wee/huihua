import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'

import type { Session } from '../../contracts/session.ts'
import { contentBlocks, jsonlProvider } from '../../shared/ingestion.ts'
import { array, object, optional, string, timestamp } from '../../shared/value.ts'

export const qwenProvider = jsonlProvider({
  id: 'qwen',
  roots(options) {
    const root = options.homeDir === undefined ? process.env.QWEN_HOME : undefined
    return options.roots?.qwen ?? [join(root ?? join(options.homeDir ?? homedir(), '.qwen'), 'projects')]
  },
  accepts: path => path.endsWith('.jsonl') && !['system.jsonl', 'system_telemetry.jsonl'].includes(basename(path)),
  metadata(records) {
    let facts: Partial<Session> = {}
    for (const native of records) {
      const v = object(native)
      const p = object(v.systemPayload)
      facts = { ...facts, ...optional('id', string(v.sessionId)), ...optional('createdAt', facts.createdAt === undefined ? timestamp(v.timestamp) : undefined), ...optional('workspace', typeof v.cwd === 'string' ? { path: v.cwd } : undefined), ...optional('title', v.subtype === 'custom_title' ? string(p.customTitle) : undefined), ...optional('parentSessionId', v.subtype === 'parent_session' ? string(p.parentSessionId) : undefined) }
    }
    return { ...facts, metadata: { ...optional('id_origin', facts.id === undefined ? undefined : 'native') } }
  },
  parse(ingest, native) {
    const v = object(native)
    const type = string(v.type) ?? 'qwen_record'
    const m = object(v.message)
    if (['user', 'assistant', 'tool_result'].includes(type)) {
      for (const part of array(m.parts)) {
        const p = object(part)
        const call = object(p.functionCall)
        const result = object(p.functionResponse)
        if ('functionCall' in p && typeof call.name === 'string') {
          ingest.emit('tool_call', { ...optional('callId', string(call.id)), toolName: call.name, arguments: call.args ?? null })
        }
        else if ('functionResponse' in p) {
          ingest.emit('tool_result', { ...optional('callId', string(result.id) ?? string(object(v.systemPayload).toolCallId)), ...optional('toolName', string(result.name)), result: result.response ?? result, isError: 'error' in object(result.response) })
        }
        else if (p.thought === true && typeof p.text === 'string') {
          ingest.emit('reasoning', { text: p.text })
        }
        else if (typeof p.text === 'string') {
          ingest.emit(type === 'assistant' ? 'assistant_message' : 'user_message', { content: contentBlocks(p.text), ...optional('model', string(v.model)) })
        }
        else if ('inlineData' in p || 'fileData' in p) {
          const data = object(p.inlineData ?? p.fileData)
          const mime = string(data.mimeType)
          ingest.emit(type === 'assistant' ? 'assistant_message' : 'user_message', { content: [{ type: mime?.startsWith('image/') ? 'image' : 'file', data: { ...optional('uri', string(data.fileUri)), ...optional('mimeType', mime), ...optional('data', data.data), metadata: p } }] })
        }
        else {
          ingest.unknown('qwen_part', part)
        }
      }
      if ('usageMetadata' in v)
        ingest.emit('usage', { usage: v.usageMetadata })
    }
    else if (type === 'system') {
      ingest.emit('system', { sourceType: string(v.subtype) ?? type, payload: native })
    }
    else {
      ingest.unknown(type, native)
    }
  },
})
