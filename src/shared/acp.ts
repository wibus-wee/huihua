import type { Timestamp } from '../contracts/event.ts'
import type { Session } from '../contracts/session.ts'
import type { Ingestion } from './ingestion.ts'
import { contentBlocks } from './ingestion.ts'
import { array, object, optional, string, timestamp } from './value.ts'

/** Offline ACP payloads; transport envelopes remain in the associated raw record. */
function acpNotification(native: unknown): Record<string, unknown> {
  const v = object(native)
  return v.method === 'session/update' ? object(v.params) : 'update' in v ? v : {}
}

export function acpMetadata(records: readonly unknown[]): Partial<Session> {
  let facts: Partial<Session> = {}
  for (const native of records) {
    const v = object(native)
    const notification = acpNotification(native)
    const params = object(v.params)
    const result = object(v.result)
    const id = string(notification.sessionId) ?? string(params.sessionId) ?? string(result.sessionId)
    if (facts.id !== undefined && id !== undefined && facts.id !== id)
      continue
    const update = object(notification.update)
    facts = {
      ...facts,
      ...optional('id', facts.id ?? id),
      ...optional('title', update.sessionUpdate === 'session_info_update' ? string(update.title) : undefined),
      ...optional('updatedAt', update.sessionUpdate === 'session_info_update' ? timestamp(update.updatedAt) : undefined),
      ...optional('workspace', ['session/load', 'session/resume'].includes(string(v.method) ?? '') && typeof params.cwd === 'string' ? { path: params.cwd } : undefined),
      metadata: { ...facts.metadata, ...optional('id_origin', id === undefined ? undefined : 'native') },
    }
  }
  return facts
}

function diffs(ingest: Ingestion, content: unknown, envelope: unknown): void {
  for (const item of array(content)) {
    const d = object(item)
    if (d.type !== 'diff')
      continue
    if (typeof d.path === 'string' && typeof d.newText === 'string') {
      ingest.emit('file_change', {
        path: d.path,
        operation: d.oldText === null ? 'create' : typeof d.oldText === 'string' ? 'modify' : 'unknown',
        ...optional('before', string(d.oldText)),
        after: d.newText,
      }, envelope, { acp_content: item })
    }
    else {
      for (const change of array(d.changes)) {
        const c = object(change)
        const path = string(c.path)
        const operation = string(c.operation)
        if (path !== undefined && ['add', 'modify', 'delete', 'move', 'copy'].includes(operation ?? '')) {
          ingest.emit('file_change', {
            path,
            operation: operation === 'copy' || operation === 'add' ? 'create' : operation === 'move' ? 'rename' : operation as 'modify' | 'delete',
            ...optional('diff', string(object(d.patch).text)),
          }, envelope, { acp_content: item, acp_change: change })
        }
        else {
          ingest.unknown('acp_diff', change)
        }
      }
    }
  }
}

export function acpEvents(ingest: Ingestion, native: unknown, at?: Timestamp): void {
  const v = object(native)
  const notification = acpNotification(native)
  const update = object(notification.update)
  const type = string(update.sessionUpdate)
  const sessionId = string(notification.sessionId) ?? string(object(v.params).sessionId)
  const envelope = { ...v, ...optional('timestamp', at?.value), sessionId, id: update.messageId }
  const evidence = { acp_update: update, ...optional('sessionId', string(notification.sessionId)), tool_scope: [notification.sessionId] }
  if (type === 'user_message_chunk' || type === 'agent_message_chunk' || type === 'user_message' || type === 'agent_message') {
    if ('content' in update && update.content !== null) {
      const role = type.startsWith('user_') ? 'user_message' : 'assistant_message'
      ingest.emit(role, { content: contentBlocks(update.content) }, envelope, evidence)
    }
    else {
      ingest.emit('system', { sourceType: type, payload: update }, envelope, evidence)
    }
  }
  else if (type === 'agent_thought_chunk' || type === 'agent_thought') {
    const blocks = contentBlocks(update.content)
    const text = blocks.filter(b => b.type === 'text').map(b => b.data).join('')
    ingest.emit('reasoning', { ...optional('text', blocks.some(b => b.type === 'text') ? text : undefined) }, envelope, evidence)
  }
  else if (type === 'tool_call' || type === 'tool_call_update') {
    const name = string(update.name) ?? (type === 'tool_call' ? string(update.title) : undefined)
    if (name !== undefined && (type === 'tool_call' || 'rawInput' in update)) {
      ingest.emit('tool_call', {
        ...optional('callId', string(update.toolCallId)),
        toolName: name,
        arguments: update.rawInput ?? null,
      }, envelope, { ...evidence, tool_name_origin: typeof update.name === 'string' ? 'name' : 'title' })
    }
    if (update.status === 'completed' || update.status === 'failed') {
      ingest.emit('tool_result', {
        ...optional('callId', string(update.toolCallId)),
        ...optional('toolName', name),
        result: update,
        isError: update.status === 'failed',
      }, envelope, evidence)
    }
    else {
      ingest.emit('system', { sourceType: type, payload: update }, envelope, evidence)
    }
    diffs(ingest, update.content, envelope)
  }
  else if (type === 'tool_call_content_chunk') {
    ingest.emit('system', { sourceType: type, payload: update }, envelope, evidence)
    diffs(ingest, [update.content], envelope)
  }
  else if (type === 'usage_update') {
    ingest.emit('usage', { usage: update }, envelope, evidence)
  }
  else if (type !== undefined && ['plan', 'plan_update', 'state_update', 'terminal_update', 'terminal_output_chunk', 'available_commands_update', 'current_mode_update', 'config_option_update', 'session_info_update'].includes(type)) {
    ingest.emit('system', { sourceType: type, payload: update }, envelope, evidence)
  }
  else if (type !== undefined) {
    ingest.unknown(type, native, undefined, envelope, evidence)
  }
  else if (v.method === 'session/request_permission') {
    ingest.emit('permission_request', { ...optional('requestId', typeof v.id === 'number' ? String(v.id) : string(v.id)), request: v.params ?? null }, v, { acp_request_id: v.id })
  }
  else if (v.method === 'session/prompt' && 'prompt' in object(v.params)) {
    ingest.emit('user_message', { content: contentBlocks(object(v.params).prompt) }, v, { message_origin: 'request', acp_request_id: v.id, sessionId: object(v.params).sessionId })
  }
  else if ('error' in v) {
    ingest.emit('error', { ...optional('message', string(object(v.error).message)), details: v.error })
  }
  else if ((typeof v.method === 'string' && ['initialize', 'session/new', 'session/load', 'session/resume', 'session/cancel', 'session/close', 'session/set_mode', 'session/set_config_option'].includes(v.method)) || ('id' in v && 'result' in v)) {
    ingest.emit('system', { sourceType: string(v.method) ?? 'acp_response', payload: native })
    const version = object(v.result).protocolVersion
    if (version !== undefined && version !== 1 && version !== 2)
      ingest.diagnostic('UnsupportedSchema', `unsupported ACP protocol version ${String(version)}`)
  }
  else {
    ingest.unknown(string(v.method) ?? 'acp_record', native, undefined, envelope, { ...optional('sessionId', sessionId) })
  }
}

/** A capture represents one session; foreign identities remain evidence with an explicit diagnostic. */
export function acpParser(mapper: (ingest: Ingestion, native: unknown) => void = acpEvents) {
  let selected: string | undefined
  return {
    parse(ingest: Ingestion, native: unknown) {
      const facts = acpMetadata([native])
      selected ??= facts.id
      if (facts.id !== undefined && selected !== facts.id)
        ingest.unknown('acp_foreign_session', native, 'ACP capture contains another session; retained without mixing its conversation')
      else
        mapper(ingest, native)
    },
  }
}
