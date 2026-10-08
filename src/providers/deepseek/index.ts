import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'

import { SessionError } from '../../contracts/diagnostic.ts'
import type { ScanEvent, ScanOptions } from '../../contracts/provider.ts'
import { scanFailure } from '../../contracts/provider.ts'
import { contentBlocks, jsonlProvider, messageEvents } from '../../shared/ingestion.ts'
import { files } from '../../shared/paths.ts'
import { array, object, optional, string, timestamp } from '../../shared/value.ts'

function roots(options: ScanOptions): readonly string[] {
  const root = options.homeDir === undefined ? process.env.DSH_HOME : undefined
  return options.roots?.deepseek ?? [join(root ?? join(options.homeDir ?? homedir(), '.dsh'), 'sessions')]
}
const accepts = (path: string) => /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(basename(path))
const generation = (path: string) => Number(/\.v(\d+)\.jsonl/.exec(basename(path))?.[1] ?? 0)

const provider = jsonlProvider({
  id: 'deepseek',
  roots,
  accepts,
  metadata(records) {
    const v = object(records.find(r => object(r).type === 'session'))
    return { ...optional('id', string(v.id)), ...optional('createdAt', timestamp(v.createdAt)), ...optional('workspace', typeof v.cwd === 'string' ? { path: v.cwd } : undefined), ...optional('parentSessionId', string(v.parentSessionId) ?? string(v.parentSession)), metadata: { ...optional('version', v.version), ...optional('origin', v.origin), ...optional('delegationDepth', v.delegationDepth), ...optional('id_origin', typeof v.id === 'string' ? 'native' : undefined) } }
  },
  time: native => timestamp(object(native).time ?? object(native).time0),
  parser() {
    let supported = true
    return {
      parse(ingest, native) {
        const v = object(native)
        const type = string(v.type) ?? 'deepseek_record'
        const d = object(v.data)
        const envelope = { ...v, timestamp: v.time ?? v.time0 }
        const evidence = { ...optional('native_seq', v.seq ?? v.seq0), ...optional('surfaceOp', v.surfaceOp), ...optional('sourceEventSeqs', v.sourceEventSeqs) }
        if (type === 'session') {
          supported = typeof v.version === 'number' && Number.isInteger(v.version) && v.version >= 0 && v.version <= 4
          ingest.emit('system', { sourceType: type, payload: native })
          if (!supported)
            ingest.diagnostic('UnsupportedSchema', `unsupported DeepSeek session version ${String(v.version)}`)
        }
        else if (!supported) {
          ingest.unknown(type, native, 'future DeepSeek event retained without guessed semantics')
        }
        else if (type === 'user/message' || type === 'assistant/message' || type === 'developer/message' || type === 'system/message') {
          const m = object(type === 'user/message' ? d : d.message)
          const role = type.split('/')[0]!
          if (role === 'system' || role === 'developer') {
            ingest.emit('system', { sourceType: type, payload: native }, { ...envelope, id: m.id }, evidence)
          }
          else {
            for (const part of array(m.content)) {
              const p = object(part)
              if (p.type === 'tool-call' && typeof p.name === 'string')
                ingest.emit('tool_call', { ...optional('callId', string(p.id)), toolName: p.name, arguments: p.arguments ?? null }, { ...envelope, id: m.id }, evidence)
              else
                messageEvents(ingest, role, part, string(object(m.source).model), { ...envelope, id: m.id }, evidence)
            }
          }
          if ('usage' in d)
            ingest.emit('usage', { usage: d.usage }, envelope, evidence)
        }
        else if (['text-chunks', 'reasoning-chunks'].includes(type)) {
          let time = typeof v.time0 === 'number' ? v.time0 : undefined
          const texts = array(d.texts)
          const gaps = array(d.dt)
          for (const [index, text] of texts.entries()) {
            if (index > 0) {
              const gap = gaps[index - 1]
              time = time !== undefined && typeof gap === 'number' && Number.isSafeInteger(gap) && gap >= 0 ? time + gap : undefined
            }
            const chunkEnvelope = { ...envelope, timestamp: time }
            const chunkEvidence = { ...evidence, ...optional('native_seq', typeof v.seq0 === 'number' ? v.seq0 + index : undefined) }
            if (typeof text === 'string') {
              if (type === 'reasoning-chunks')
                ingest.emit('reasoning', { text }, chunkEnvelope, chunkEvidence)
              else
                ingest.emit('assistant_message', { content: contentBlocks(text) }, chunkEnvelope, chunkEvidence)
            }
            else {
              ingest.unknown(type, native)
            }
          }
        }
        else if (['tool/call', 'tool/code-dispatch-start', 'tool/ptc-dispatch-start'].includes(type) && typeof d.name === 'string') {
          ingest.emit('tool_call', { ...optional('callId', string(d.callId) ?? string(d.subCallId)), toolName: d.name, arguments: d.arguments ?? null }, envelope, evidence)
        }
        else if (['tool/result', 'tool/code-dispatch', 'tool/ptc-dispatch'].includes(type)) {
          const m = object(d.message)
          const results = array(m.content).map(object).filter(p => p.type === 'tool-result')
          const callId = string(m.toolCallId) ?? string(object(m.source).callId) ?? string(d.callId) ?? string(d.subCallId)
          for (const result of results.length ? results : [{}])
            ingest.emit('tool_result', { ...optional('callId', string(result.toolCallId) ?? callId), ...optional('toolName', string(d.name)), result: d, isError: result.isError === true || m.isError === true || d.isError === true }, envelope, evidence)
        }
        else if (['turn/start', 'turn/end', 'step/start', 'step/end', 'request/header', 'compaction/start', 'compaction/summary', 'compaction/end', 'session-log-deepseek/delivery-accepted'].includes(type)) {
          ingest.emit('system', { sourceType: type, payload: native }, envelope, evidence)
        }
        else {
          ingest.unknown(type, native, undefined, envelope, evidence)
        }
      },
    }
  },
  parse() {},
})

export const deepseekProvider = {
  ...provider,
  async* scan(options: ScanOptions = {}): AsyncGenerator<ScanEvent> {
    const selected = new Map<string, { path: string, ambiguous: boolean }>()
    for await (const path of files(roots(options), accepts, options, 'deepseek')) {
      if (typeof path !== 'string') {
        yield path
        continue
      }
      const key = dirname(path)
      const prior = selected.get(key)
      if (!prior || generation(path) > generation(prior.path))
        selected.set(key, { path, ambiguous: false })
      else if (generation(path) === generation(prior.path))
        prior.ambiguous = true
    }
    for (const [directory, candidate] of selected) {
      if (candidate.ambiguous) {
        yield { type: 'failure', failure: scanFailure('deepseek', new SessionError('UnsupportedSchema', `ambiguous DeepSeek session generation in ${directory}`), { path: directory }) }
        continue
      }
      for await (const event of provider.scan({ ...options, roots: { ...options.roots, deepseek: [candidate.path] } })) {
        if (event.type === 'ref' && event.ref.metadata.version !== generation(event.ref.source.path)) {
          yield { type: 'failure', failure: scanFailure('deepseek', new SessionError('UnsupportedSchema', 'DeepSeek generation filename does not match its native header'), { path: event.ref.source.path, format: event.ref.source.format }) }
        }
        else {
          yield event
        }
      }
    }
  },
}
