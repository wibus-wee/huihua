import { acpEvents, acpMetadata, acpParser } from '../../shared/acp.ts'
import { jsonlProvider } from '../../shared/ingestion.ts'

/** Recorded JSON-RPC or bare SessionNotification JSONL; ACP defines no default export directory. */
export const acpProvider = jsonlProvider({
  id: 'acp',
  roots: options => options.roots?.acp ?? [],
  metadata: acpMetadata,
  parse: acpEvents,
  parser: acpParser,
})
