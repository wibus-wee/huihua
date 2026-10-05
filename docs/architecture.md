# Session data architecture

Huihua discovers, scans and reads local session stores.
It normalizes common facts and preserves
native evidence.
It does not execute agents, connect to networks, mutate stores or provide runtime
control, search, indexing, memory, analytics or UI.

| Layer / owner   | Contract                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------- |
| src/contracts   | Public types and thin provider SPI; depends only on contracts                                   |
| src/registry.ts | Consumer-extensible composition, provider lookup, filtering and dispatch; no builtin identities |
| src/index.ts    | The sole builtin composition root; exports sessions and its AgentSession alias                  |
| src/providers/* | Discovery policy and native-to-canonical mapping; no inter-provider imports                     |
| src/shared      | Provider-independent JSONL, paths, binary/SQLite reads and ingestion primitives                 |
| src/observe     | Disposable projections using public contracts only                                              |
| src/testing     | Runner-independent evidence and ordering assertions                                             |

## Evidence and schema

A Session uses agent-session/v1. records contains one RawRecord per persisted record read for that
session; events refers to record.sequence.
Multiple block/usage/tool events can share one record.
Sequence numbers are stable read order starting at zero, independent of timestamps or native IDs.
Do not deduplicate repeated IDs, mirrored records or branches.
Unknown semantics produce unknown
events and diagnostics.
Raw SQL rows, JSON fields and original text remain reachable.

Optional properties are absent when the source does not establish a fact.
Timestamps retain a
discriminator for native RFC3339 strings versus millisecond epochs, without guessing units.
SessionRef.source identifies the exact store and selector: IDs alone need not be globally unique.
Scan-derived titles and IDs are metadata, not reconstructed conversation content.
Fallback IDs
are labeled in metadata.
Pi parentSession is a native path; event parentId/parentUuid is an edge,
not an invented session lineage.
Source native usage objects are not summed or rewritten.

RawRecord.native is the decoded value. text retains original JSON numeric lexemes, including
unsafe integer and decimal spellings that ordinary JavaScript JSON.parse cannot represent
exactly.
Consumers needing those lexemes should read text, not rounded JS numbers.
Binary values
use native_bytes; SQLite integers outside the safe range use native_integer decimal strings.
This is evidence preservation, not a bit-perfect database roundtrip.
Public JSON is JSON.stringify
or jsonOf; it includes records as well as events.
Consumers must tolerate future optional fields
and unknown event sourceType values.
agent-session/v1 is the first public schema under development; the package is unpublished.
After publication, breaking representation or meaning changes require a new schema.

## Reading and streaming

scan inspects directory entries, bounded JSONL headers (64 KiB, eight physical lines) and database
session metadata.
It never normalizes a full transcript.
Explicit roots replace defaults;
explicit homeDir isolates discovery from process environment.
Relative XDG roots are ignored.
Missing stores return no refs; permission errors and unsupported schemas remain explicit errors.

open returns a lazy handle.
Each stream(), events(), records() or snapshot() invocation opens a
fresh source and closes it on completion, early return, cancellation or error.
Replays can observe
source changes; they are not a shared cached snapshot. stream includes evidence, events, metadata
patches and diagnostics. events/records are convenience filters, so use stream to inspect partial
parse diagnostics while iterating. read is equivalent to open().snapshot() and necessarily stores
the complete result in memory.
ReadOptions.signal supports cancellation and maxRecordBytes limits
native records (16 MiB default, including a JSONL newline).

OpenSession.readMode describes the selected source's iteration strategy.
incremental delivers records as read; buffered may collect selected rows for ordering or a complete snapshot before delivering them.
JSONL, compressed JSONL and historical OpenCode filesystem reads are incremental.
Cursor IDE and OpenCode SQLite reads, and the registry's read-only SPI fallback, are buffered.
Both modes remain lazy and open a fresh source for each replay; neither promises a fixed memory ceiling.
snapshot collects the full session in either mode.
Providers own this declaration; the registry does not infer it from provider IDs or file extensions.

JSONL is read incrementally with backpressure; malformed JSON/UTF-8 becomes unknown evidence and
later records continue.
A record exceeding the limit fails explicitly.
Compressed frames have a
32 MiB window ceiling, a 4 GiB declared-frame-size ceiling, dictionary rejection and content
checksum/size validation.
A streamed prefix is provisional until the iterator completes: a later
record/checksum/store-change error can still occur. snapshot never returns such an incomplete
success.
Early return intentionally does not validate an unread suffix.

SQLite reads rowid tables and overflow pages directly.
It maintains a 1 MiB page cache, validates
WAL header/frame checksums and overlays only committed transactions.
It never opens a source
through a SQLite engine, creates sidecars, checkpoints, repairs or acquires write locks.
Nonempty
rollback journals fail PartialParse.
File identity/size/time checks reject changing stores; this
is not atomic isolation against an active writer.
Scan still walks relevant table pages and the
WAL; no index or live-store cache is created.
Cursor ordering and OpenCode SQL sorting can buffer
a selected session's rows, so database adapters do not promise JSONL's bounded streaming memory.
Virtual, generated-column, encrypted and WITHOUT ROWID stores are explicitly unsupported.

The minimal third-party SPI requires detect/scan/read; defineProvider preserves the adapter's
type.
Implement open for streaming.
Otherwise the registry offers an explicitly eager fallback.
Duplicate provider registration fails rather than silently replacing an owner.

## Direct acquisition

SessionRegistry.parse(provider, input, options) separates acquisition from discovery.
FileInput supplies a path, optional format (JSONL by default), id and locator; the registry dispatches directly to the existing read SPI.
A caller id is also the default locator.id; an explicit locator can retain provider-specific selectors.
There is no provider identity switch, scan fallback, directory discovery or header pre-read.
SQLite inputs need selectors because a database is not a single transcript; historical filesystem sessions still read their associated message/part layout.

JsonlInput supplies uncompressed UTF-8 text, bytes or an asynchronous byte iterable and an optional provenance label.
The optional provider.parse capability consumes this acquired input; adapters without it fail UnsupportedSchema.
The four JSONL adapters share one bounded line framer and native-to-event pipeline for file and memory ingestion.
Incomplete JSON, invalid UTF-8, unknown records, limits and tool diagnostics retain the same behavior.
Caller-owned chunks are copied before requesting another chunk, allowing producers to reuse buffers.
Text encoding uses bounded chunks without splitting surrogate pairs.
Ill-formed UTF-16 input strings fail instead of silently replacing evidence; escaped JSON surrogate lexemes remain valid.
No temporary files or filesystem access are used for supplied JSONL.

An explicit id is authoritative; otherwise the first observed native identity is selected and later mismatches are diagnosed without removing evidence.
A source label is not a workspace fact or file path to read.
Changing acquisition can change provenance and fallback identities, but does not change event mapping.
The serialized schema remains agent-session/v1.
parse returns a snapshot; byte iterables are consumed once, and events/raw evidence accumulate in the result.
Cancellation is checked between records and chunks; an external producer waiting on its own I/O must also handle the caller's signal.
read/open still accept caller-constructed SessionRef values without discovery, including custom providers that implement only the minimal SPI.

## Projections and review boundaries

eventsOf(session, ...types) selects one or more canonical event types and narrows the readonly result array to their union.
Calling it without an event type fails TypeError, including from JavaScript.
The result follows input order, independently of selector order; repeated selector types do not duplicate events.
Original event objects, repeated native IDs and evidence associations remain intact.

conversationOf selects user_message and assistant_message; toolCallsOf and toolResultsOf select calls and results separately.
fileChangesOf selects file_change, and subagentsOf selects subagent lifecycle events.
These convenience functions use eventsOf and do not require a registered provider or read private provider structures.
Empty results establish only the absence of matching normalized events, not format support or mapping completeness.
Further conditions use ordinary array filtering.

Selection does not merge split message blocks, strip wrappers, deduplicate mirrored records, match calls to results or construct agent trees.
Relationship extraction belongs to the provider that understands the native format; future relationship queries must use public facts with evidence and preserve missing or ambiguous targets.
No relationship store or query framework is part of this API.
The current builtin adapters do not emit file_change; checkpoints remain unknown evidence rather than inferred historical diffs.

Machine checks enforce import directions, sources/dependencies, type safety, fixture/golden
semantics and public package exports.
Review owns mapping completeness, fact-versus-inference,
private-schema compatibility, abstraction reuse and whether new API belongs in this data layer.
