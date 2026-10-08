import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'

import { SessionError } from '../../contracts/diagnostic.ts'
import { chatMessageEvents } from '../../shared/ingestion.ts'
import { jsonStoreProvider } from '../../shared/json-store.ts'
import { array, object, optional, string, timestamp } from '../../shared/value.ts'

export const clineProvider = jsonStoreProvider({
  id: 'cline',
  format: 'cline_json',
  roots(options) {
    const configured = options.homeDir === undefined ? process.env.CLINE_DATA_DIR : undefined
    return options.roots?.cline ?? [configured !== undefined && configured.trim() !== '' ? join(configured, 'sessions') : join(options.homeDir ?? homedir(), '.cline/data/sessions')]
  },
  accepts: path => basename(path) === `${basename(dirname(path))}.json`,
  sources: path => [path, join(dirname(path), `${basename(path, '.json')}.messages.json`)],
  metadata(native) {
    const v = object(native)
    return { ...optional('id', string(v.session_id) ?? string(v.sessionId)), ...optional('title', string(object(v.metadata).title)), ...optional('createdAt', timestamp(v.started_at)), ...optional('updatedAt', timestamp(v.ended_at) ?? timestamp(v.updated_at)), ...optional('workspace', typeof (v.cwd ?? v.workspace_root) === 'string' ? { path: String(v.cwd ?? v.workspace_root) } : undefined), metadata: { ...optional('surface', string(v.source)), id_origin: 'native' } }
  },
  parse(ingest, native) {
    const v = object(native)
    if (v.version !== 1)
      throw new SessionError('UnsupportedSchema', `unsupported Cline snapshot version ${String(v.version)}`)
    ingest.emit('system', { sourceType: 'messages' in v ? 'cline_messages' : 'cline_manifest', payload: native })
    for (const nativeMessage of array(v.messages)) {
      const m = object(nativeMessage)
      chatMessageEvents(ingest, m, { ...m, timestamp: m.ts })
    }
  },
})
