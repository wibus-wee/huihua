import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'

import { chatMessageEvents } from '../../shared/ingestion.ts'
import { binarySafe } from '../../shared/sqlite.ts'
import { sqliteStoreProvider } from '../../shared/sqlite-store.ts'
import { array, object, optional, parseNative, string, timestamp } from '../../shared/value.ts'

const seconds = (value: unknown) => typeof value === 'number' ? timestamp(Math.round(value * 1000)) : undefined
export const devinProvider = sqliteStoreProvider({
  id: 'devin',
  format: 'devin_sqlite',
  roots(options) {
    const xdg = options.homeDir === undefined ? process.env.XDG_DATA_HOME : undefined
    return options.roots?.devin ?? [join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(options.homeDir ?? homedir(), '.local/share'), 'devin/cli/sessions.db')]
  },
  accepts: path => path.endsWith('.db'),
  table: 'message_nodes',
  columns: ['session_id', 'node_id', 'parent_node_id', 'chat_message'],
  metadata(row) {
    return { ...optional('id', string(row.id)), ...optional('title', string(row.title)), ...optional('createdAt', seconds(row.created_at)), ...optional('updatedAt', seconds(row.last_activity_at)), ...optional('workspace', typeof row.working_directory === 'string' ? { path: row.working_directory } : undefined), metadata: { id_origin: 'native', ...optional('main_chain_id', row.main_chain_id), ...optional('hidden', row.hidden) } }
  },
  normalize(ingest, rows, session, ref, options) {
    const byId = new Map(rows.map(row => [String(row.node_id), row]))
    const chain = new Set<typeof rows[number]>()
    const ordered: typeof rows = []
    let next = session.main_chain_id
    let validChain = byId.size === rows.length
    if (!validChain)
      ingest.diagnostic('PartialParse', 'Devin has repeated node IDs; branch membership is ambiguous')
    while (next !== null && next !== undefined) {
      options.signal?.throwIfAborted()
      const row = byId.get(String(next))
      if (!row || chain.has(row)) {
        ingest.diagnostic('PartialParse', 'Devin main chain has a missing parent or cycle; all native nodes retained')
        validChain = false
        break
      }
      chain.add(row)
      ordered.push(row)
      next = row.parent_node_id
    }
    const scopes = new Map<typeof rows[number], string>()
    for (const row of chain)
      scopes.set(row, 'main_chain')
    function scope(row: typeof rows[number]): string {
      const known = scopes.get(row)
      if (known !== undefined)
        return known
      const trace: typeof rows = []
      const seen = new Set<typeof rows[number]>()
      let current: typeof rows[number] | undefined = row
      let result: string | undefined
      while (current !== undefined) {
        options.signal?.throwIfAborted()
        const cached = scopes.get(current)
        if (cached !== undefined) {
          result = cached === 'main_chain' ? `branch:${String(trace.at(-1)?.node_id)}` : cached
          break
        }
        if (seen.has(current)) {
          ingest.diagnostic('PartialParse', 'Devin abandoned branch has a parent cycle')
          break
        }
        trace.push(current)
        seen.add(current)
        const parent: unknown = current.parent_node_id
        current = parent === undefined || parent === null ? undefined : byId.get(String(parent))
      }
      result ??= `branch:${String(trace.at(-1)?.node_id)}`
      for (const entry of trace)
        scopes.set(entry, result)
      return result
    }
    ordered.reverse()
    ordered.push(...rows.filter(row => !chain.has(row)))
    for (const [position, row] of ordered.entries()) {
      options.signal?.throwIfAborted()
      ingest.record(binarySafe(row), { path: ref.source.path, table: 'message_nodes', key: String(row.node_id) })
      let message: unknown
      try {
        message = typeof row.chat_message === 'string' ? parseNative(row.chat_message) : row.chat_message
      }
      catch {
        ingest.unknown('devin_chat_message', binarySafe(row), 'invalid Devin chat_message JSON')
        continue
      }
      const envelope = { id: string(object(message).message_id) ?? (typeof row.node_id === 'number' || typeof row.node_id === 'bigint' ? String(row.node_id) : row.node_id), timestamp: seconds(row.created_at)?.value }
      chatMessageEvents(ingest, message, envelope, { tool_scope: validChain ? scope(row) : `ambiguous_node:${position}`, node_id: binarySafe(row.node_id), parent_node_id: binarySafe(row.parent_node_id), ...optional('on_main_chain', validChain ? chain.has(row) : undefined) })
      if (object(message).role === 'user') {
        for (const image of array(object(message).images)) {
          const media = object(image)
          ingest.emit('user_message', { content: [{ type: 'image', data: { ...optional('data', media.base64_data), metadata: media } }] }, envelope)
        }
      }
    }
  },
})
