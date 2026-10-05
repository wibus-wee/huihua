import { Buffer } from 'node:buffer'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { SessionError } from '../../contracts/diagnostic.ts'
import type { Ingestion } from '../../shared/ingestion.ts'
import { contentBlocks } from '../../shared/ingestion.ts'
import { jsonStoreProvider } from '../../shared/json-store.ts'
import { array, object, optional, string, timestamp } from '../../shared/value.ts'

function durable(value: unknown): unknown {
  const v = object(value)
  if (v.encoding === 'base64' && typeof v.data === 'string') {
    const bytes = Buffer.from(v.data, 'base64')
    try {
      return new TextDecoder('utf8', { fatal: true }).decode(bytes)
    }
    catch {
      return value
    }
  }
  return value
}
function call(ingest: Ingestion, native: unknown) {
  const c = object(native)
  if (typeof c.name === 'string')
    ingest.emit('tool_call', { ...optional('callId', string(c.id)), toolName: c.name, arguments: c.arguments_json ?? null })
  else
    ingest.unknown('fx_tool_call', native)
}
export const fxProvider = jsonStoreProvider({
  id: 'fx',
  format: 'fx_json',
  roots: options => options.roots?.fx ?? [join(options.homeDir ?? homedir(), '.fx/sessions')],
  accepts: path => basename(path) === 'session.json',
  sources: path => [path, join(dirname(path), 'checkpoint.json')],
  metadata(native) {
    const v = object(native)
    const state = object(v.state ?? native)
    return { ...optional('id', string(v.session_id) ?? string(state.id)), ...optional('createdAt', timestamp(state.created_at_ms)), ...optional('updatedAt', timestamp(state.updated_at_ms)), ...optional('workspace', typeof state.workspace_root === 'string' ? { path: state.workspace_root } : undefined), metadata: { id_origin: 'native' } }
  },
  parse(ingest, native) {
    const v = object(native)
    const checkpoint = 'state' in v
    if (checkpoint ? v.schema_version !== 1 : v.schema_version !== 3 || v.storage_format !== 'event_log_v1')
      throw new SessionError('UnsupportedSchema', 'unsupported fx snapshot schema')
    ingest.emit('system', { sourceType: checkpoint ? 'fx_checkpoint' : 'fx_manifest', payload: native })
    if (!checkpoint)
      return
    const state = object(v.state)
    ingest.diagnostic('PartialParse', 'fx checkpoint snapshot only; events after through_seq are not replayed')
    for (const nativeTurn of array(state.history)) {
      const turn = object(nativeTurn)
      if (!['assistant', 'interrupted', 'background_command', 'compacted_summary'].includes(String(turn.kind))) {
        ingest.unknown('fx_history', nativeTurn)
        continue
      }
      const user = object(turn.user)
      if ('text' in user)
        ingest.emit('user_message', { content: contentBlocks(durable(user.text)) })
      for (const image of array(user.images))
        ingest.emit('user_message', { content: [{ type: 'image', data: { data: image, metadata: object(image) } }] })
      for (const nativeStep of array(object(turn.execution).tool_steps)) {
        const step = object(nativeStep)
        if (step.assistant !== null && step.assistant !== undefined)
          ingest.emit('assistant_message', { content: contentBlocks(durable(step.assistant)) })
        for (const tool of array(step.tool_calls))
          call(ingest, tool)
        for (const nativeResult of array(step.tool_results)) {
          const r = object(nativeResult)
          ingest.emit('tool_result', { ...optional('callId', string(r.tool_call_id)), ...optional('toolName', string(r.tool_name)), result: r, isError: r.status === 'failure' }, { timestamp: r.created_at_ms })
        }
      }
      if (turn.assistant !== null && turn.assistant !== undefined)
        ingest.emit('assistant_message', { content: contentBlocks(durable(turn.assistant)) })
      if (turn.tool_call !== null && turn.tool_call !== undefined)
        call(ingest, turn.tool_call)
      if (turn.kind === 'compacted_summary' || turn.kind === 'interrupted')
        ingest.emit('system', { sourceType: String(turn.kind), payload: nativeTurn })
    }
  },
})
