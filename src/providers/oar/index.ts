import type { Session } from '../../contracts/session.ts'
import type { Ingestion } from '../../shared/ingestion.ts'
import { contentBlocks, jsonlProvider } from '../../shared/ingestion.ts'
import { array, object, optional, string, timestamp } from '../../shared/value.ts'

function parse(ingest: Ingestion, native: unknown): void {
  const line = object(native)
  if (line.kind === 'header') {
    if (line.format !== 'oar-voyage/3') {
      ingest.unknown('oar_header', native)
      ingest.diagnostic('UnsupportedSchema', `unsupported OAR voyage format ${String(line.format)}`)
    }
    else {
      ingest.emit('system', { sourceType: 'oar_header', payload: native })
    }
    return
  }
  if (line.kind === 'end') {
    ingest.emit('system', { sourceType: 'oar_end', payload: native })
    return
  }
  const record = line.kind === 'record' ? object(line.record) : line
  const body = object(record.body)
  const envelope = { ...record, timestamp: record.receivedAt }
  const evidence = {
    ...optional('agentPath', record.agentPath),
    ...optional('spanId', record.spanId),
    ...optional('native_seq', record.seq),
    ...optional('receivedAt', record.receivedAt),
    tool_scope: [record.sessionId, record.agentPath],
    oar_record_kind: record.kind,
  }
  if (record.kind === 'frame') {
    const events = array(body.events)
    if (!events.length) {
      ingest.unknown(string(body.type) ?? 'oar_frame', native, undefined, envelope, evidence)
      return
    }
    for (const event of events) {
      const e = object(event)
      const details = { ...evidence, oar_event: event }
      const eventEnvelope = { ...envelope, id: e.nativeMessageId ?? e.messageId }
      if (e.kind === 'user_message' && typeof e.input === 'string') {
        ingest.emit('user_message', { content: contentBlocks(e.input) }, eventEnvelope, details)
      }
      else if (e.kind === 'text_delta' && typeof e.text === 'string') {
        ingest.emit('assistant_message', { content: contentBlocks(e.text) }, eventEnvelope, details)
      }
      else if (e.kind === 'reasoning') {
        const content = object(e.content)
        ingest.emit('reasoning', { ...optional('text', string(content.text)) }, envelope, details)
      }
      else if (e.kind === 'tool_call_started' && typeof e.tool === 'string') {
        ingest.emit('tool_call', { ...optional('callId', string(e.callId)), toolName: e.tool, arguments: e.input ?? null }, envelope, details)
      }
      else if (e.kind === 'tool_call_ended') {
        ingest.emit('tool_result', { ...optional('callId', string(e.callId)), result: event, isError: e.result === 'failed' }, envelope, details)
      }
      else if (e.kind === 'usage') {
        ingest.emit('usage', { usage: e.usage ?? null }, envelope, details)
      }
      else if (e.kind === 'task_started' && e.taskType === 'agent' && typeof e.taskId === 'string') {
        ingest.emit('subagent', { agentId: string(e.childSessionId) ?? e.taskId, kind: 'started', ...optional('name', string(e.description)), metadata: e }, envelope, details)
      }
      else if (e.kind === 'turn_ended' && object(e.outcome).kind === 'failed') {
        ingest.emit('error', { ...optional('message', string(object(e.outcome).reason)), details: e.outcome }, envelope, details)
      }
      else if (['tool_call_progress', 'turn_ended', 'compaction_started', 'compaction_ended', 'retry', 'model', 'effort', 'task_started', 'task_updated', 'task_ended'].includes(string(e.kind) ?? '')) {
        ingest.emit('system', { sourceType: String(e.kind), payload: event }, envelope, details)
      }
      else {
        ingest.unknown(string(e.kind) ?? 'oar_event', event, undefined, envelope, details)
      }
    }
  }
  else if (record.kind === 'request') {
    if (record.direction === 'toRuntime' && ['prompt', 'steer', 'queue'].includes(string(body.kind) ?? '') && typeof body.input === 'string') {
      ingest.emit('user_message', { content: [...contentBlocks(body.input), ...array(body.images).map(data => ({ type: 'structured' as const, data }))] }, envelope, { ...evidence, message_origin: 'request', oar_input: body })
    }
    else if (record.direction === 'toApp' && body.kind === 'native' && ['session/request_permission', 'approval', 'control_request/can_use_tool'].includes(string(body.type) ?? '')) {
      ingest.emit('permission_request', { ...optional('requestId', string(record.id)), request: body.native ?? null }, envelope, evidence)
    }
    else {
      ingest.emit('system', { sourceType: `oar_request/${String(body.kind)}`, payload: native }, envelope, evidence)
    }
  }
  else if (record.kind === 'response') {
    if (body.kind === 'rejected') {
      ingest.emit('error', { ...optional('message', string(body.reason)), details: body }, envelope, evidence)
    }
    else {
      ingest.emit('system', { sourceType: `oar_response/${String(body.kind)}`, payload: native }, envelope, evidence)
    }
  }
  else {
    ingest.unknown(string(record.kind) ?? 'oar_record', native)
  }
}

export const oarProvider = jsonlProvider({
  id: 'oar',
  roots: options => options.roots?.oar ?? [],
  metadata(records) {
    let facts: Partial<Session> = {}
    for (const native of records) {
      const v = object(native)
      if (v.kind === 'header' && v.format === 'oar-voyage/3') {
        facts = {
          ...optional('id', string(v.sessionId)),
          ...optional('createdAt', timestamp(v.startedAt)),
          ...optional('workspace', typeof v.cwd === 'string' ? { path: v.cwd } : undefined),
          metadata: { ...v, id_origin: typeof v.sessionId === 'string' ? 'native' : 'source_locator' },
        }
      }
    }
    return facts
  },
  time(native) {
    const v = object(native)
    return timestamp(v.kind === 'record' ? object(v.record).receivedAt : v.kind === 'end' ? v.at : v.receivedAt)
  },
  parse,
  parser() {
    let voyage = false
    let ended = false
    return {
      parse(ingest, native) {
        const v = object(native)
        voyage ||= v.kind === 'header'
        if (v.kind === 'end')
          ended = true
        parse(ingest, native)
      },
      finish(ingest) {
        if (voyage && !ended)
          ingest.diagnostic('PartialParse', 'OAR voyage has no recorded end marker; capture may be truncated')
      },
    }
  },
})
