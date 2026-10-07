/**
 * Provider-authoring kit: re-exports the bounded shared primitives and store
 * factories that builtin adapters are built on, so third-party providers can
 * conform to the same contracts without duplicating them. The thin
 * SessionProvider SPI in contracts/provider.ts remains sufficient on its own;
 * nothing here is required to implement it.
 */
export { positiveLimit, scanFailure } from '../contracts/provider.ts'
export type { JsonlAdapter, JsonlCandidate } from '../shared/ingestion.ts'
export {
  chatMessageEvents,
  contentBlocks,
  Ingestion,
  joinedText,
  jsonlProvider,
  messageEvents,
  openFrom,
} from '../shared/ingestion.ts'
export { readJson } from '../shared/json-file.ts'
export { jsonStoreProvider } from '../shared/json-store.ts'
export type { NativeLine } from '../shared/jsonl.ts'
export { header, jsonLines, jsonLinesFrom } from '../shared/jsonl.ts'
export {
  canonicalPath,
  exists,
  files,
  ioError,
  ioErrorOf,
  isDirectory,
  pathMatcher,
} from '../shared/paths.ts'
export { scanSource } from '../shared/scan.ts'
export type { Row } from '../shared/sqlite.ts'
export { sqliteStoreProvider } from '../shared/sqlite-store.ts'
export { array, object, optional, string, timestamp } from '../shared/value.ts'
