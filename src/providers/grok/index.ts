import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'

import type { Session } from '../../contracts/session.ts'
import { acpEvents, acpMetadata } from '../../shared/acp.ts'
import { jsonlProvider } from '../../shared/ingestion.ts'
import { object, optional, string, timestamp } from '../../shared/value.ts'

function time(native: unknown) {
  const value = object(native).timestamp
  return typeof value === 'number' ? timestamp(value * 1000) : undefined
}

export const grokProvider = jsonlProvider({
  id: 'grok',
  roots(options) {
    const home = options.homeDir === undefined ? process.env.GROK_HOME : undefined
    return options.roots?.grok ?? [join(home ?? join(options.homeDir ?? homedir(), '.grok'), 'sessions')]
  },
  accepts: path => basename(path) === 'updates.jsonl',
  metadataFiles: path => [join(dirname(path), 'summary.json')],
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
          metadata: { ...facts.metadata, ...optional('id_origin', typeof info.id === 'string' ? 'native' : undefined) },
        }
      }
    }
    return facts
  },
  time,
  parse(ingest, native) {
    const v = object(native)
    if ('info' in v)
      ingest.emit('system', { sourceType: 'grok_summary', payload: native })
    else
      acpEvents(ingest, native, time(native))
  },
})
