import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'

import type { Session } from '../../contracts/session.ts'
import { contentBlocks, jsonlProvider } from '../../shared/ingestion.ts'
import { isDirectory, pathMatcher } from '../../shared/paths.ts'
import { array, object, optional, string, timestamp } from '../../shared/value.ts'

const chatPath = pathMatcher(['*/chats/*.jsonl', '*/chats/archive/*.jsonl'])

export const qwenProvider = jsonlProvider({
  id: 'qwen',
  async roots(options) {
    if (options.roots?.qwen)
      return options.roots.qwen
    const root = options.homeDir === undefined ? process.env.QWEN_HOME : undefined
    const fallback = join(options.homeDir ?? homedir(), '.qwen/projects')
    const configured = root !== undefined && root !== '' ? join(root, 'projects') : undefined
    return [configured !== undefined && await isDirectory(configured) ? configured : fallback]
  },
  accepts(path, candidate) {
    if (!path.endsWith('.jsonl') || ['system.jsonl', 'system_telemetry.jsonl'].includes(basename(path)))
      return false
    if (candidate.explicitFile)
      return true
    if (!/^[\da-f-]{32,36}\.jsonl$/i.test(basename(path)))
      return false
    return candidate.roots.some(root => chatPath(path, root))
  },
  identify({ path, header, explicitFile }) {
    if (explicitFile)
      return {}
    const id = basename(path, '.jsonl')
    return object(header[0]).sessionId === id ? { id, metadata: { id_origin: 'native' } } : false
  },
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
    const tool = object(v.toolCallResult)
    if (['user', 'assistant', 'tool_result'].includes(type)) {
      for (const part of array(m.parts)) {
        const p = object(part)
        const call = object(p.functionCall)
        const result = object(p.functionResponse)
        if ('functionCall' in p && typeof call.name === 'string') {
          ingest.emit('tool_call', { ...optional('callId', string(call.id)), toolName: call.name, arguments: call.args ?? null })
        }
        else if ('functionResponse' in p) {
          ingest.emit('tool_result', { ...optional('callId', string(result.id) ?? string(object(v.systemPayload).toolCallId) ?? string(tool.callId)), ...optional('toolName', string(result.name)), result: result.response ?? result, isError: object(result.response).error != null || tool.error != null || tool.status === 'error' })
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
