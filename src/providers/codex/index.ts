import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import type { Session } from '../../contracts/session.ts'
import {
  joinedText,
  jsonlProvider,
  messageEvents,
} from '../../shared/ingestion.ts'
import { object, optional, string, timestamp } from '../../shared/value.ts'

export const codexProvider = jsonlProvider({
  id: 'codex',
  usageContext: true,
  roots(options) {
    const root
      = options.homeDir === undefined ? process.env.CODEX_HOME : undefined
    return (
      options.roots?.codex ?? [
        join(root ?? join(options.homeDir ?? homedir(), '.codex'), 'sessions'),
        join(
          root ?? join(options.homeDir ?? homedir(), '.codex'),
          'archived_sessions',
        ),
      ]
    )
  },
  accepts: path => path.endsWith('.jsonl') || path.endsWith('.jsonl.zst'),
  metadata(records, _path, _context, keys) {
    const facts: Partial<Session> = {}
    const wantsWorkspace = keys === undefined || keys.includes('workspace')
    const wantsCreated = keys === undefined || keys.includes('createdAt')
    const wantsParent = keys === undefined || keys.includes('parentSessionId')
    const wantsMetadata = keys === undefined || keys.includes('metadata')
    for (const record of records) {
      const v = object(record)
      if (v.type !== 'session_meta')
        continue
      const p = object(v.payload)
      const git = object(p.git)
      Object.assign(facts, {
        ...optional('id', string(p.id)),
        ...optional(
          'createdAt',
          wantsCreated ? timestamp(v.timestamp) ?? timestamp(p.timestamp) : undefined,
        ),
        ...optional(
          'parentSessionId',
          wantsParent ? string(p.parent_thread_id) ?? string(p.forked_from_id) : undefined,
        ),
        ...optional('metadata', wantsMetadata
          ? {
              ...optional(
                'id_origin',
                string(p.id) === undefined ? undefined : 'native',
              ),
            }
          : undefined),
      })
      const workspace = wantsWorkspace
        ? {
            ...optional('path', string(p.cwd)),
            ...optional('repository', string(git.repository_url)),
            ...optional('branch', string(git.branch)),
            ...optional('commit', string(git.commit_hash)),
          }
        : undefined
      if (workspace !== undefined && Object.keys(workspace).length)
        Object.assign(facts, { workspace })
    }
    return facts
  },
  parse(ingest, native) {
    const v = object(native)
    const p = object(v.payload)
    const type = string(v.type) ?? 'unknown'
    const subtype = string(p.type) ?? 'unknown'
    if (
      type === 'session_meta'
      || type === 'turn_context'
      || type === 'compacted'
    ) {
      ingest.emit('system', {
        sourceType: type,
        payload: type === 'session_meta' ? p : native,
      })
      return
    }
    if (type === 'token_usage_record' && 'usage' in p) {
      ingest.emit('usage', { usage: p }, undefined, ingest.usageContext
        ? () => ({ native_usage_context: { ...optional('model', string(p.model)) } })
        : undefined)
      return
    }
    if (type === 'response_item') {
      if (subtype === 'message') {
        const role = string(p.role)
        if (role === 'user' || role === 'assistant')
          messageEvents(ingest, role, p.content ?? null, string(p.model))
        else if (role === 'system' || role === 'developer')
          ingest.emit('system', { sourceType: 'response_message', payload: p })
        else ingest.unknown(subtype, p)
      }
      else if (subtype === 'reasoning') {
        ingest.emit('reasoning', {
          ...optional('text', joinedText(p.content)),
          ...optional('summary', joinedText(p.summary)),
          ...optional('encrypted', p.encrypted_content ?? undefined),
        })
      }
      else if (subtype === 'function_call' || subtype === 'custom_tool_call') {
        if (typeof p.name !== 'string') {
          ingest.unknown(subtype, p)
          return
        }
        let args: unknown = p.arguments ?? p.input ?? null
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args) as unknown
          }
          catch {
            ingest.diagnostic(
              'PartialParse',
              'tool arguments are not valid JSON',
            )
          }
        }
        ingest.emit('tool_call', {
          ...optional('callId', string(p.call_id)),
          toolName: p.name,
          arguments: args,
        })
      }
      else if (
        subtype === 'function_call_output'
        || subtype === 'custom_tool_call_output'
      ) {
        ingest.emit('tool_result', {
          ...optional('callId', string(p.call_id)),
          ...optional('toolName', string(p.name)),
          result: p.output ?? null,
          isError: p.is_error === true,
        })
      }
      else if (subtype === 'local_shell_call') {
        ingest.emit('command', { command: p.action ?? null })
      }
      else {
        ingest.unknown(subtype, p)
      }
      return
    }
    if (type === 'event_msg') {
      if (subtype === 'user_message' || subtype === 'agent_message') {
        messageEvents(
          ingest,
          subtype === 'user_message' ? 'user' : 'assistant',
          p.message ?? null,
          string(p.model),
        )
      }
      else if (subtype === 'agent_reasoning') {
        ingest.emit('reasoning', { ...optional('text', string(p.text)) })
      }
      else if (subtype === 'token_count') {
        ingest.emit('usage', { usage: p }, undefined, ingest.usageContext
          ? () => ({ native_usage_context: { ...optional('model', string(p.model)) } })
          : undefined)
      }
      else if (subtype === 'error') {
        ingest.emit('error', {
          ...optional('message', string(p.message)),
          details: p,
        })
      }
      else if (
        subtype === 'exec_approval_request'
        || subtype === 'apply_patch_approval_request'
      ) {
        ingest.emit('permission_request', {
          ...optional('requestId', string(p.call_id)),
          request: p,
        })
      }
      else if (subtype === 'collab_agent_spawn_begin') {
        ingest.emit('system', { sourceType: subtype, payload: p })
      }
      else if (
        [
          'collab_agent_spawn_end',
          'collab_agent_interaction_begin',
          'collab_agent_interaction_end',
          'collab_close_end',
          'collab_resume_end',
        ].includes(subtype)
      ) {
        const id = string(p.new_thread_id) ?? string(p.receiver_thread_id)
        if (id === undefined) {
          ingest.unknown(subtype, p)
          return
        }
        const status = object(p.status)
        const kind
          = 'completed' in status
            ? 'completed'
            : 'errored' in status
              ? 'failed'
              : subtype === 'collab_agent_spawn_end'
                ? 'spawn'
                : subtype === 'collab_resume_end'
                  ? 'started'
                  : subtype.startsWith('collab_agent_interaction')
                    ? 'message'
                    : undefined
        if (kind === undefined) {
          ingest.unknown(subtype, p)
          return
        }
        ingest.emit('subagent', {
          agentId: id,
          ...optional(
            'parentAgentId',
            subtype === 'collab_agent_spawn_end'
              ? string(p.sender_thread_id)
              : undefined,
          ),
          kind,
          ...optional(
            'name',
            string(p.new_agent_nickname) ?? string(p.receiver_agent_nickname),
          ),
          metadata: p,
        })
      }
      else {
        ingest.unknown(subtype, p)
      }
      return
    }
    ingest.unknown(type, native)
  },
})
