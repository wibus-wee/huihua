import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Session } from '../../contracts/session.ts'
import { contentBlocks, jsonlProvider } from '../../shared/ingestion.ts'
import { array, object, optional, string, timestamp } from '../../shared/value.ts'

export const copilotProvider = jsonlProvider({
  id: 'copilot',
  roots: options => options.roots?.copilot ?? [join(options.homeDir ?? homedir(), '.copilot/session-state')],
  metadata(records) {
    let facts: Partial<Session> = {}
    for (const native of records) {
      const v = object(native)
      const d = object(v.data)
      if (v.type === 'session.start') {
        const context = object(d.context)
        facts = { ...optional('id', string(d.sessionId)), ...optional('createdAt', timestamp(d.startTime) ?? timestamp(v.timestamp)), ...optional('workspace', typeof context.cwd === 'string' ? { path: context.cwd } : undefined), metadata: { id_origin: 'native', version: d.version } }
      }
      if (v.type === 'session.title_changed')
        facts = { ...facts, ...optional('title', string(d.title)) }
    }
    return facts
  },
  parse(ingest, native) {
    const v = object(native)
    const d = object(v.data)
    const type = string(v.type) ?? 'copilot_record'
    if (type === 'user.message' || type === 'assistant.message') {
      if ('content' in d || Array.isArray(d.attachments)) {
        ingest.emit(type === 'user.message' ? 'user_message' : 'assistant_message', { content: [...('content' in d ? contentBlocks(d.content) : []), ...array(d.attachments).flatMap((attachment) => {
          const a = object(attachment)
          if (a.type === 'blob' && typeof a.mimeType === 'string')
            return contentBlocks({ ...a, type: a.mimeType.startsWith('image/') ? 'image' : 'file' })
          return contentBlocks(attachment)
        })], ...optional('model', string(d.model)) })
      }
      const reasoning = string(d.reasoningText)
      const encrypted = d.encryptedContent ?? d.reasoningOpaque ?? undefined
      if (reasoning !== undefined || encrypted !== undefined)
        ingest.emit('reasoning', { ...optional('text', reasoning), ...optional('encrypted', encrypted) })
      for (const request of array(d.toolRequests)) {
        const call = object(request)
        if (typeof call.name === 'string')
          ingest.emit('tool_call', { ...optional('callId', string(call.toolCallId)), toolName: call.name, arguments: call.arguments ?? null })
        else
          ingest.unknown('copilot_tool_request', request)
      }
    }
    else if (type === 'assistant.reasoning' && typeof d.content === 'string') {
      ingest.emit('reasoning', { text: d.content })
    }
    else if (type === 'tool.execution_start' && typeof d.toolName === 'string') {
      ingest.emit('tool_call', { ...optional('callId', string(d.toolCallId)), toolName: d.toolName, arguments: d.arguments ?? null })
    }
    else if (type === 'tool.execution_complete') {
      ingest.emit('tool_result', { ...optional('callId', string(d.toolCallId)), ...optional('toolName', string(d.toolName)), result: d, isError: d.success === false })
    }
    else if (type === 'assistant.usage' || type === 'session.usage_checkpoint') {
      ingest.emit('usage', { usage: d })
    }
    else if (type === 'session.error') {
      ingest.emit('error', { ...optional('message', string(d.message)), details: native })
    }
    else if (['session.start', 'session.resume', 'session.shutdown', 'session.model_change', 'session.info', 'session.title_changed', 'session.truncation', 'session.compaction_start', 'session.compaction_complete', 'assistant.turn_start', 'assistant.turn_end', 'system.message', 'hook.start', 'hook.end'].includes(type)) {
      ingest.emit('system', { sourceType: type, payload: native })
      if (type === 'session.shutdown' && 'modelMetrics' in d)
        ingest.emit('usage', { usage: d })
    }
    else {
      ingest.unknown(type, native)
    }
  },
})
