import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'

import type { ScanOptions } from '../../contracts/provider.ts'
import type { Session } from '../../contracts/session.ts'
import { acpEvents, acpMetadata } from '../../shared/acp.ts'
import { chatMessageEvents, joinedText, jsonlProvider } from '../../shared/ingestion.ts'
import { exists, files, ioError } from '../../shared/paths.ts'
import { object, optional, string, timestamp } from '../../shared/value.ts'

function time(native: unknown) {
  const value = object(native).timestamp
  return typeof value === 'number' ? timestamp(value * 1000) : undefined
}

const provider = jsonlProvider({
  id: 'grok',
  roots: providerRoots,
  accepts: path => ['updates.jsonl', 'chat_history.jsonl'].includes(basename(path)),
  async metadataFiles(path) {
    const paths = [join(dirname(path), 'summary.json')]
    const bucket = dirname(dirname(path))
    let siblings
    try {
      siblings = await readdir(bucket, { withFileTypes: true })
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return paths
      ioError(error, bucket)
    }
    const id = basename(dirname(path))
    for (const sibling of siblings.filter(s => s.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const meta = join(bucket, sibling.name, 'subagents', id, 'meta.json')
      if (await exists(meta))
        paths.push(meta)
    }
    return paths
  },
  metadata(records) {
    let facts: Partial<Session> = acpMetadata(records)
    for (const native of records) {
      const v = object(native)
      const info = object(v.info)
      if ('info' in v) {
        facts = {
          ...facts,
          ...optional('id', string(info.id)),
          ...optional('title', string(v.generated_title) ?? string(v.session_summary)),
          ...optional('createdAt', timestamp(v.created_at)),
          ...optional('updatedAt', timestamp(v.updated_at)),
          ...optional('workspace', typeof info.cwd === 'string' ? { path: info.cwd } : undefined),
          ...optional('parentSessionId', string(v.parent_session_id)),
          metadata: { ...facts.metadata, ...optional('current_model_id', v.current_model_id), ...optional('id_origin', typeof info.id === 'string' ? 'native' : undefined) },
        }
      }
      else if (typeof v.parent_session_id === 'string') {
        facts = { ...facts, parentSessionId: v.parent_session_id, metadata: { ...facts.metadata, ...optional('subagent_type', v.subagent_type), ...optional('description', v.description) } }
      }
    }
    return facts
  },
  time,
  parse(ingest, native) {
    const v = object(native)
    if ('info' in v || typeof v.parent_session_id === 'string') {
      ingest.emit('system', { sourceType: 'grok_summary', payload: native })
    }
    else if (['user', 'assistant', 'system'].includes(String(v.type))) {
      chatMessageEvents(ingest, { ...v, role: v.type, model: v.model_id }, { ...v, timestamp: time(native)?.value }, { source_family: 'derived_chat_history' })
    }
    else if (v.type === 'reasoning') {
      ingest.emit('reasoning', { ...optional('text', joinedText(v.content)), ...optional('summary', joinedText(v.summary)), ...optional('encrypted', v.encrypted_content) }, { ...v, timestamp: time(native)?.value }, { source_family: 'derived_chat_history' })
    }
    else if (v.type === 'tool_result') {
      ingest.emit('tool_result', { ...optional('callId', string(v.tool_call_id)), ...optional('toolName', string(v.name)), result: v.content ?? null, isError: v.is_error === true }, { ...v, timestamp: time(native)?.value }, { source_family: 'derived_chat_history' })
    }
    else {
      acpEvents(ingest, native, time(native))
    }
  },
})
export const grokProvider = {
  ...provider,
  async* scan(options: ScanOptions = {}) {
    const explicit = new Set(options.roots?.grok?.map(path => resolve(path)))
    for await (const path of files(providerRoots(options), p => ['updates.jsonl', 'chat_history.jsonl'].includes(basename(p)), options, 'grok')) {
      if (typeof path !== 'string') {
        yield path
        continue
      }
      if (basename(path) === 'chat_history.jsonl' && !explicit.has(resolve(path)) && await exists(join(dirname(path), 'updates.jsonl')))
        continue
      yield* provider.scan({ ...options, roots: { grok: [path] } })
    }
  },
}
function providerRoots(options: ScanOptions) {
  const home = options.homeDir === undefined ? process.env.GROK_HOME : undefined
  return options.roots?.grok ?? [join(home !== undefined && home !== '' ? home : join(options.homeDir ?? homedir(), '.grok'), 'sessions')]
}
