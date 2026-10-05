import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'

import { SessionError } from '../../contracts/diagnostic.ts'
import type { ReadOptions, ScanOptions } from '../../contracts/provider.ts'
import type { SessionFrame, SessionRef } from '../../contracts/session.ts'
import { contentBlocks, Ingestion, jsonlProvider, openFrom } from '../../shared/ingestion.ts'
import { readJson } from '../../shared/json-file.ts'
import { jsonLines } from '../../shared/jsonl.ts'
import { exists, files, positiveLimit } from '../../shared/paths.ts'
import { array, object, optional, string, timestamp } from '../../shared/value.ts'

function roots(options: ScanOptions): readonly string[] {
  const root = options.homeDir === undefined ? process.env.MISTER_MORPH_FILE_STATE_DIR : undefined
  return options.roots?.morph ?? [root ?? join(options.homeDir ?? homedir(), '.morph')]
}
function topicId(native: unknown): string | undefined {
  const v = object(native)
  const payload = object(v.payload)
  return string(object(v.trace).topic_id) ?? string(object(payload.task).topic_id) ?? string(object(payload.topic).id)
}
function parse(ingest: Ingestion, native: unknown): void {
  const v = object(native)
  const payload = object(v.payload)
  const task = object(payload.task)
  const envelope = { ...v, timestamp: v.time ?? v.at }
  const evidence = { topic_id: topicId(native), task_id: task.id, snapshot: true }
  if (v.domain === 'task' && ['task_upsert', 'task_update'].includes(string(v.type) ?? '') && typeof task.id === 'string') {
    if (typeof task.task === 'string')
      ingest.emit('user_message', { content: contentBlocks(task.task) }, envelope, evidence)
    const result = object(task.result)
    const output = typeof task.result === 'string' ? task.result : object(result.final).output ?? result.output
    if (output !== undefined)
      ingest.emit('assistant_message', { content: typeof output === 'string' ? contentBlocks(output) : [{ type: 'structured', data: output }], ...optional('model', string(task.model)) }, envelope, evidence)
    if (typeof task.error === 'string')
      ingest.emit('error', { message: task.error, details: task }, envelope, evidence)
    ingest.emit('system', { sourceType: String(v.type), payload: native }, envelope, evidence)
    if (v.schema_version !== 1)
      ingest.diagnostic('UnsupportedSchema', `unsupported Morph journal version ${String(v.schema_version)}`)
  }
  else if (v.domain === 'task' && ['topic_upsert', 'topic_title_updated', 'topic_tags_updated', 'topic_deleted'].includes(string(v.type) ?? '')) {
    ingest.emit('system', { sourceType: String(v.type), payload: native }, envelope, evidence)
    const topic = object(payload.topic)
    ingest.patch({ ...optional('title', string(topic.title)), ...optional('createdAt', timestamp(topic.created_at)), ...optional('updatedAt', timestamp(topic.updated_at)) })
  }
  else {
    ingest.unknown(string(v.type) ?? 'morph_record', native)
  }
}
const jsonl = jsonlProvider({
  id: 'morph',
  roots,
  metadata: () => ({}),
  time: native => timestamp(object(native).time),
  parse,
  accepts: path => /^events\.\d+\.jsonl$/.test(basename(path)),
})
async function open(ref: SessionRef, options: ReadOptions = {}) {
  if (ref.source.format !== 'morph_journal')
    return jsonl.open(ref, options)
  if (ref.provider !== 'morph')
    throw new SessionError('ProviderNotFound', `expected morph, got ${ref.provider}`)
  const id = string(ref.source.locator?.id)
  if (id === undefined)
    throw new SessionError('UnsupportedSchema', 'Morph journal needs a topic locator.id')
  async function* stream(): AsyncGenerator<SessionFrame> {
    const ingest = new Ingestion('morph')
    const projection = join(ref.source.path, 'stats/topics_projection.json')
    if (await exists(projection)) {
      const record = await readJson(projection, positiveLimit(options.maxRecordBytes, 16 * 1024 * 1024), false, options.signal)
      ingest.record(record.native, { path: projection }, record)
      if (record.malformed)
        ingest.unknown('morph_topics', record.native, 'invalid Morph topics projection')
      else
        ingest.emit('system', { sourceType: 'morph_topics', payload: record.native })
      yield* ingest.drain()
    }
    for await (const path of files([join(ref.source.path, 'journal')], p => /^events\.\d+\.jsonl$/.test(basename(p)), options.signal)) {
      for await (const line of jsonLines(path, false, options)) {
        const topic = topicId(line.native)
        if (topic !== undefined && topic !== id)
          continue
        ingest.record(line.native, { path, position: line.position }, line)
        if (line.malformed)
          ingest.unknown('malformed_jsonl', line.native, 'corrupted Morph journal record')
        else if (topic === undefined)
          ingest.unknown('unscoped_morph_record', line.native, 'Morph journal record has no topic attribution; retained without assigning it')
        else
          parse(ingest, line.native)
        yield* ingest.drain()
      }
    }
    yield* ingest.finish()
  }
  return openFrom(ref, stream, 'incremental')
}
export const morphProvider = {
  ...jsonl,
  async scan(options: ScanOptions = {}) {
    const refs: SessionRef[] = []
    for await (const path of files(roots(options), p => basename(p) === 'topics_projection.json', options.signal)) {
      const value = await readJson(path, positiveLimit(options.headerBytes, 65536), false, options.signal)
      const projection = object(value.native)
      if (value.malformed || projection.version !== 1)
        throw new SessionError('UnsupportedSchema', 'unsupported Morph topics projection')
      for (const native of array(projection.items)) {
        const topic = object(native)
        if (typeof topic.id === 'string') {
          refs.push({
            id: topic.id,
            provider: 'morph',
            ...optional('title', string(topic.title)),
            ...optional('createdAt', timestamp(topic.created_at)),
            ...optional('updatedAt', timestamp(topic.updated_at)),
            metadata: { id_origin: 'native' },
            source: { path: dirname(dirname(path)), format: 'morph_journal', locator: { id: topic.id } },
          })
        }
      }
    }
    return refs
  },
  open,
  async read(ref: SessionRef, options?: ReadOptions) {
    return (await open(ref, options)).snapshot()
  },
}
