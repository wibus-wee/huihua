import { homedir } from 'node:os'
import { join } from 'node:path'

import { chatMessageEvents, contentBlocks, jsonlProvider } from '../../shared/ingestion.ts'
import { object, optional, string, timestamp } from '../../shared/value.ts'

export const droidProvider = jsonlProvider({
  id: 'droid',
  roots: options => options.roots?.droid ?? [join(options.homeDir ?? homedir(), '.factory/sessions'), join(options.homeDir ?? homedir(), '.factory/projects')],
  metadata(records) {
    const v = object(records.find(r => ['session_start', 'system'].includes(String(object(r).type))))
    return { ...optional('id', string(v.session_id) ?? (v.type === 'session_start' ? string(v.id) : undefined)), ...optional('title', string(v.title)), ...optional('createdAt', timestamp(v.timestamp)), ...optional('workspace', typeof v.cwd === 'string' ? { path: v.cwd } : undefined), metadata: { compatibility: 'legacy_jsonl' } }
  },
  parse(ingest, native) {
    const v = object(native)
    const type = string(v.type) ?? 'droid_record'
    if (type === 'message')
      chatMessageEvents(ingest, v.message ?? { ...v, content: v.content ?? v.text }, v)
    else if (type === 'tool_call' && typeof v.toolName === 'string')
      ingest.emit('tool_call', { ...optional('callId', string(v.toolCallId)), toolName: v.toolName, arguments: v.parameters ?? null })
    else if (type === 'tool_result')
      ingest.emit('tool_result', { ...optional('callId', string(v.toolCallId)), ...optional('toolName', string(v.toolName)), result: v.value ?? native, isError: v.isError === true || v.is_error === true })
    else if (type === 'completion' && typeof v.finalText === 'string')
      ingest.emit('assistant_message', { content: contentBlocks(v.finalText) })
    else if (type === 'error')
      ingest.emit('error', { ...optional('message', string(v.message)), details: native })
    else if (['session_start', 'system', 'completion'].includes(type))
      ingest.emit('system', { sourceType: type, payload: native })
    else
      ingest.unknown(type, native)
  },
})
