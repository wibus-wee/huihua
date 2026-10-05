import { homedir } from 'node:os'
import { join } from 'node:path'

import { chatMessageEvents, contentBlocks, jsonlProvider } from '../../shared/ingestion.ts'
import { object, optional, string, timestamp } from '../../shared/value.ts'

export const droidProvider = jsonlProvider({
  id: 'droid',
  roots: options => options.roots?.droid ?? [join(options.homeDir ?? homedir(), '.factory/sessions'), join(options.homeDir ?? homedir(), '.factory/projects')],
  metadata(records) {
    const v = object(records.find(r => ['session_start', 'system'].includes(String(object(r).type))) ?? records.find(r => typeof object(r).session_id === 'string' || typeof object(r).sessionId === 'string'))
    const id = string(v.session_id) ?? string(v.sessionId) ?? (v.type === 'session_start' ? string(v.id) : undefined)
    const cwd = string(v.cwd) ?? string(v.working_directory)
    return { ...optional('id', id), ...optional('title', string(v.title)), ...optional('createdAt', ['session_start', 'system'].includes(String(v.type)) ? timestamp(v.timestamp) : undefined), ...optional('workspace', cwd === undefined ? undefined : { path: cwd }), metadata: { compatibility: 'legacy_jsonl', ...optional('id_origin', id === undefined ? undefined : 'native') } }
  },
  parse(ingest, native) {
    const v = object(native)
    const type = string(v.type) ?? 'droid_record'
    const callId = string(v.toolCallId) ?? string(v.tool_call_id) ?? string(v.toolCallID) ?? string(v.id)
    const toolName = string(v.toolName) ?? string(v.tool_name) ?? string(v.name)
    if (type === 'message') {
      const message = object(v.message ?? { ...v, content: v.content ?? v.text })
      chatMessageEvents(ingest, { ...message, role: string(message.role)?.trim().toLowerCase() }, v)
    }
    else if ((type === 'tool_call' || type === 'toolCall') && toolName !== undefined) {
      ingest.emit('tool_call', { ...optional('callId', callId), toolName, arguments: v.parameters ?? v.input ?? null })
    }
    else if (type === 'tool_result') {
      const result = object(v.value)
      const exitCode = result.exitCode ?? result.exit_code ?? v.exitCode ?? v.exit_code
      const flag = v.isError ?? v.is_error
      ingest.emit('tool_result', { ...optional('callId', callId), ...optional('toolName', toolName), result: v.value ?? native, isError: flag === true || (typeof flag === 'string' && ['true', '1'].includes(flag.trim().toLowerCase())) || (typeof exitCode === 'number' && Number.isSafeInteger(exitCode) && exitCode !== 0) })
    }
    else if (type === 'completion') {
      const final = string(v.finalText) ?? string(v.final) ?? string(v.text)
      if (final !== undefined)
        ingest.emit('assistant_message', { content: contentBlocks(final) })
      else
        ingest.emit('system', { sourceType: type, payload: native })
      if ('usage' in v)
        ingest.emit('usage', { usage: v.usage })
    }
    else if (type === 'error') {
      ingest.emit('error', { ...optional('message', string(v.message)), details: native })
    }
    else if (['session_start', 'system'].includes(type)) {
      ingest.emit('system', { sourceType: type, payload: native })
    }
    else {
      ingest.unknown(type, native)
    }
  },
})
