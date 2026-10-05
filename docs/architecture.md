# Session data architecture

Huihua discovers, scans and reads local session stores.
It normalizes common facts and preserves
native evidence.
It does not execute agents, connect to networks, mutate stores or provide runtime
control, search, indexing, memory, analytics or UI.

| Layer / owner   | Contract                                                                                |
| --------------- | --------------------------------------------------------------------------------------- |
| src/contracts   | Public types, validation and thin provider SPI; depends only on contracts               |
| src/registry.ts | Consumer-extensible composition, scan orchestration and dispatch; no builtin identities |
| src/index.ts    | The sole builtin composition root; exports sessions and its AgentSession alias          |
| src/providers/* | Discovery policy and native-to-canonical mapping; no inter-provider imports             |
| src/shared      | Provider-independent discovery failures, paths and bounded ingestion primitives         |
| src/observe     | Disposable projections using public contracts only                                      |
| src/testing     | Runner-independent evidence and ordering assertions                                     |

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
Grok's documented epoch seconds are converted to milliseconds; raw records retain their original seconds.
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
agent-session/v1 is the first public schema; its version is independent of the npm package version.
Breaking representation or meaning changes require a new schema.

## Scanning and failure reports

scan inspects directory entries, bounded JSONL headers (64 KiB, eight physical lines) and database
session metadata.
It never normalizes a full transcript.
Explicit roots replace defaults;
explicit homeDir isolates discovery from process environment.
Relative XDG roots are ignored.

[contracts/provider.ts](../src/contracts/provider.ts) owns ScanResult, ScanEvent, ScanFailure and
the provider scan SPI.
Provider scan returns `AsyncIterable<ScanEvent>`, emitting ref or failure
at each discovery boundary. [SessionRegistry](../src/registry.ts) consumes providers sequentially;
scanStream exposes their events, and scan collects them into { refs, failures }.
No progress events, concurrent scheduling or retries are part of this contract.

Both registry methods retain the first ref for each JSON.stringify([ref.provider, ref.source]) key.
IDs from different paths or selectors remain separate. scanStream emits refs in discovery order;
scan sorts its collected refs by provider, path and ID with the existing English locale comparator.
Failures retain discovery order and are not deduplicated.
A failure never retracts earlier refs.
Those refs establish discovered sources, not successful transcript reads or an atomic store snapshot.

| Condition                                                         | Outcome                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| Missing store or no matching entries                              | No refs or failures                                                |
| Source permission, I/O, corruption, schema or changed-store error | Source failure; retain its prefix and continue independent sources |
| Unexpected provider exception                                     | Provider failure; retain its prefix and continue later providers   |
| Unregistered requested provider or invalid headerBytes            | Throw before entering providers                                    |
| Aborted caller signal                                             | Propagate the signal reason and stop; collected scan rejects       |

ScanFailure.provider accepts custom IDs. scope identifies a source boundary or a terminated provider;
source, when known, contains the failing path and optional format.
Discovery directory failures do
not fabricate a format or session selector.
Companion metadata failures name the companion path
and skip that transcript's ref rather than fabricate metadata. code reuses ErrorCode; unclassified
exceptions use Unknown.
message is display text; cause retains the original thrown value or SessionError with its native cause.
ScanFailure is an in-process report, not a new serialized Session schema.
There is no partial boolean: even a scan with zero refs can have incomplete coverage.

[shared/paths.ts](../src/shared/paths.ts) owns one filesystem traversal.
Read-side files(roots, accepts, signal) throws on I/O errors; scan-side
files(roots, accepts, options, provider) emits failure events and continues sibling entries and roots.
The same walker uses one stat per entry; ENOENT means no source, and scan options are validated
before traversal even when roots are empty.

[shared/scan.ts](../src/shared/scan.ts) owns scanSource, the shared source failure boundary.
It converts SessionError and native filesystem exceptions into failure events; unexpected adapter
exceptions escape to the registry.
Shared JSONL, JSON and SQLite adapters reuse it; providers own native selectors, metadata and
which sources are independent.
Source handles close on completion, error, cancellation or early return.
The yielding guards distinguish source/provider exceptions from consumer throw()/return() and
cleanup errors while returning early; consumer errors propagate instead of becoming discovery events.

Async generators provide backpressure without another stream framework or dependency.
DeepSeek still gathers candidate filenames before emitting refs so it can select the highest
generation per directory; an ambiguous or mismatched selection fails that source without falling
back to an older generation.
Cursor's modern metadata rows are emitted as discovered; legacy
indexes are used only when no modern composer metadata exists.
SQLite close-time validation can
emit a source failure after refs have already been emitted.

This changes both public scan's former array return and the third-party `Promise<SessionRef[]>` SPI.
Consumers must destructure { refs, failures }; adapters must yield ScanEvent values and close their
sources in finally.
No legacy array-returning SPI is retained.
An array-returning scan loses its prefix on rejection; a refs-only iterable cannot recover from a
source exception without ending its iterator.
The event SPI provides one ordered channel with a collected convenience API.
Session evidence and agent-session/v1 remain unchanged.
The existing resource-limit validator lives with the contracts so registry preflight and source
helpers share it without reversing the registry's dependency direction.

[Behavior regressions](../tests/behavior.test.ts), [SQLite regressions](../tests/sqlite.test.ts) and
[provider compatibility tests](../tests/provider-imports.test.ts) enforce isolation, prefix retention,
source identity, ordering, cancellation and cleanup. [Installed-package checks](../tools/package.ts)
validate report types and the event SPI through supported package exports.

## Reading and streaming

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
JSONL, compressed JSONL, Morph journal segments and historical OpenCode filesystem reads are incremental.
Cursor IDE, OpenCode, Antigravity, Hermes, Devin and OpenClaw SQLite reads, JSON snapshots, and the registry's read-only SPI fallback, are buffered.
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
The optional provider.parse capability returns an acquired snapshot; provider.stream returns acquired SessionFrame values.
The registry dispatches each capability independently through the [public SPI](../src/contracts/provider.ts), with no provider identity switch or snapshot fallback for stream.
Adapters without the requested capability fail UnsupportedSchema; registry.stream reports capability/lookup and pre-aborted signal errors synchronously, before returning an iterable.
All JSONL adapters share one bounded line framer and native-to-event pipeline for file and memory ingestion.
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
stream returns a lazy sequence of record/event/diagnostic/metadata frames without collecting a Session.
The shared JSONL adapter owns acquired-input identity, encoding and single-consumer enforcement; both capabilities use its acquisition helper and ingestLines mapping, while openFrom owns snapshot collection.
ingestLines owns cancellation at frame yields and EOF, so acquisition does not forward every frame through another async generator.
Acquired byte iterables go directly to the existing framer; only text and byte arrays need encoding/chunk adaptation.
The companion-file prelude uses a source wrapper only for file adapters with metadataFiles; ordinary JSONL lines retain their native position and use the reference's provenance path directly.
No input iterator is opened or advanced until the consumer requests a frame.
Frame delivery follows consumer backpressure without prefetching another source chunk; one input chunk or native record may contain multiple frames.
Parser state and outstanding tool diagnostics can still grow, so incremental output does not promise a fixed memory ceiling.

Each acquired sequence accepts one consumer, including for text and byte-array inputs.
Obtaining its iterator claims the sequence; a second iterator request throws TypeError while active, after completion, after early return or after failure.
To replay, call stream again with text/bytes or a fresh iterable.
Reusing an exhausted producer across separate calls cannot reconstruct its input.
This lifecycle differs from file-backed OpenSession, whose methods open a fresh source for each replay.
Early return, consumer failure and parser errors close the acquired producer through iterator return.
Producer failures propagate unchanged; producers own cleanup when their next() fails.
Cancellation is checked between acquired frames and chunks, including before successful completion; an external producer waiting on its own I/O must also handle the caller's signal.
Previously emitted prefixes remain provisional until successful EOF; early return intentionally skips unread suffix validation and end-of-input diagnostics.
read/open still accept caller-constructed SessionRef values without discovery, including custom providers that implement only the minimal SPI.

An additive stream capability preserves existing parse, read, open, third-party SPI and agent-session/v1 semantics.
Overloading OpenSession for acquired iterables would weaken its replay contract; returning a snapshot-backed stream would retain the full-session accumulation this capability avoids.
A separate parser, downstream internal imports or temporary files would duplicate mapping or mix acquisition with filesystem access.
The existing framer, ingestion pipeline and Node APIs suffice; no dependency or provider-format change is required.
Network acquisition, uploads and batch persistence remain caller responsibilities; this capability does not certify a separate Worker runtime.
[Acquisition tests](../tests/parse.test.ts) enforce frame equivalence using the existing fixture manifest, backpressure, evidence, lifecycle and capability dispatch.
The [installed-package checks](../tools/package.ts) enforce runtime access and emitted declaration types for both the registry and provider subpaths.
The [stream performance experiment](performance.md) compares each removed forwarding layer with the retained lifecycle protections and records reproducible benchmark commands and raw measurements.

## Provider coverage and format ownership

Each `src/providers/<id>/RESEARCH.md` owns its native format evidence and limitations.
The composition root registers providers; each provider also has an independent package subpath.
The public schema remains agent-session/v1 and existing provider mappings remain compatible.
New provider IDs and source formats are additive; consumers should continue accepting custom provider IDs and unknown events.

| Provider    | Source and discovery                                                                             | Mapping boundary                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| oar         | Explicit voyage/3 or RawEvent JSONL; no default directory                                        | Recorded OAR projections for any harness; complete wrappers/native payloads retained                 |
| acp         | Explicit JSON-RPC or bare SessionNotification JSONL; no default directory                        | Stable v1/v2 updates; no universal ACP export archive or live connection                             |
| kimi        | KIMI_CODE_HOME/sessions or ~/.kimi-code/sessions; each agents/*/wire.jsonl                       | Confirmed flat durable wire records and companion state.json; no Python kimi-cli or ZIP decoder      |
| grok        | GROK_HOME/sessions or ~/.grok/sessions; updates.jsonl                                            | Standard ACP updates and summary.json; unmapped xAI extensions remain unknown                        |
| antigravity | AGY_CONVERSATIONS_DIR or ~/.gemini/antigravity-cli/conversations; *.db                           | Partial observed CLI steps schema; no guarantee for Google's separate ACP-server/IDE store           |
| morph       | MISTER_MORPH_FILE_STATE_DIR or ~/.morph; stats/topics_projection.json and journal/events.*.jsonl | Current topic/task journal; repeated snapshots retained; custom config paths use explicit roots      |
| copilot     | ~/.copilot/session-state; flat JSONL and events.jsonl                                            | Native messages, mirrored tool requests/execution and usage; no quota accounting                     |
| hermes      | HERMES_HOME or ~/.hermes; state.db and historical sessions                                       | All selected SQLite rows, JSON snapshots and JSONL captures/exports; no routing/index ingestion      |
| openclaw    | OPENCLAW_STATE_DIR/agents or ~/.openclaw/agents and legacy ~/.clawdbot/agents                    | Selected session_windows/transcript_events, Zstandard payloads and legacy JSONL; no cold restoration |
| qwen        | QWEN_HOME/projects or ~/.qwen/projects; chat JSONL                                               | Native Google parts, usage and system subtypes; telemetry excluded, malformed data never repaired    |
| devin       | Absolute XDG_DATA_HOME or ~/.local/share; devin/cli/sessions.db                                  | All selected message nodes; native chain order and branch markers; no inferred usage                 |
| fx          | ~/.fx/sessions; session.json and checkpoint.json                                                 | Manifest-3/checkpoint-1 history snapshots; post-checkpoint event tail diagnosed                      |
| cline       | ~/.cline/data/sessions; <id>.json and adjacent <id>.messages.json                                | Version-1 CLI/Desktop messages, metrics and surface; external paths never followed                   |
| deepseek    | DSH_HOME/sessions or ~/.dsh/sessions; session[.vN].jsonl[.zstd]                                  | Highest immutable generation, known v0–v4 facts; no migration or surface replay                      |
| droid       | ~/.factory/sessions and ~/.factory/projects; JSONL                                               | Legacy stored messages and stream-json captures; no current private-store certification              |

Together with Claude, Codex, Cursor and Pi, these cover readable native formats for OAR's current harness inventory, including community Morph.
Coverage is defined by the table and adjacent research, not by harness name alone.
OpenCode remains independently supported.
OAR recordings carry their runtime name in metadata; it never replaces source provider=oar or dispatches to another provider.
The recording reader works for future/custom runtime names when the recorded event vocabulary is known.

ACP does not impose a storage format.
Its provider accepts recorded protocol objects, not arbitrary exports from every ACP client.
One ACP capture represents one native session.
Its first identity wins; foreign session records stay unknown with diagnostics and are excluded from the selected conversation.
An explicit caller id labels the result and does not select an unrelated session from a multiplexed log.
Chunks, complete-message upserts, outbound prompts and echoes remain separate observations.
Partial tool updates never acquire fields from earlier updates; native update objects retain patch/null semantics.
v1 tool_call titles are explicit display labels, marked tool_name_origin, and v2 programmatic names are used where supplied.
Only explicit completed/failed statuses become tool results.
ACP diff operations are normalized only from native structured facts; copy/move provenance remains in event metadata.

OAR records preserve sessionId, agentPath, spanId, seq and receivedAt in normalized event metadata.
Canonical sequence is physical read order; OAR observation time is distinct from any timestamp inside its native payload.
Tool diagnostics use an optional native tool_scope to keep same-ID calls from different agents separate; this does not establish a call/result relationship API.
Unknown event vocabulary and empty frame projections stay unknown evidence.
A voyage header without an end marker receives a truncation diagnostic on complete consumption.
Early return does not inspect an unread suffix.
RawEvent-only captures have a labeled source identity when no authoritative voyage header exists.

Kimi and Grok may supply adjacent metadata files through the shared JSONL adapter's metadataFiles hook.
Scan reads bounded metadata prefixes; open reads each complete companion within maxRecordBytes, preserves its native value/text and actual path, then reads the wire.
The companion is a metadata prelude, not an invented historical event in the transcript's chronology.
Missing companions do not fabricate workspace or identity; malformed companions remain unknown evidence.
Supplied JSONL never opens companion files, even when its provenance label looks like a real local path.
Kimi agent files remain separate refs; no timestamp sort invents a global order among independent streams.

Morph's `morph_journal` source is a state directory with locator.id selecting a topic.
Scan uses bounded topics_projection.json; a larger projection fails the supplied limit instead of scanning the complete journal.
Open streams zero-padded segments in filename order and physical lines in order, preserving complete selected records.
Foreign explicitly attributed topics are outside the selector; unscoped records remain unknown without invented attribution.
The projection is retained as metadata evidence, and current workspace files, runtime endpoints, credentials and config are never read to reconstruct history.
Direct acquired Morph JSONL represents the recorded capture, with topic attribution, rather than a topic selector.

JSON snapshot acquisition belongs to shared/json-store.ts; Cline, fx and historical Hermes own file selection and mapping.
The helper reuses readJson and Ingestion, retains each complete file as one raw record, and reports buffered mode.
Scan reads only the discovery JSON file within headerBytes; oversized snapshots fail explicitly rather than scanning their embedded transcript without a bound.
Companion native identities must agree even when the caller labels the result with another ID.
Manifest paths never authorize following arbitrary embedded filesystem paths.
A streaming JSON parser is an alternative for larger snapshots, but these adapters need complete native-object evidence and the existing bounded reader fits the documented limit; no parallel JSON parser is introduced.

Selected row-store acquisition belongs to shared/sqlite-store.ts; Hermes, Devin and OpenClaw own native tables, metadata, ordering and message mapping.
The helper validates required columns, requires locator.id, preserves the selected metadata row and buffers selected transcript rows.
It reuses SqliteReader's read-only WAL, source-change and row-limit checks.
Provider callbacks check cancellation during normalization; unknown embedded JSON remains associated with the complete original SQL row.
Hermes retains inactive/compacted rows in ID order.
Devin emits the native main chain in root-to-tip order followed by remaining nodes in database row order; node_id, parent_node_id and on_main_chain retain branch evidence.
Missing parents, cycles and repeated node IDs invalidate confident membership without discarding nodes.
The existing tool_scope diagnostic key follows native branch roots so an abandoned-branch result cannot satisfy a main-chain call with the same ID; it does not expose a call/result relationship API.
OpenClaw selects session_windows.session_id and orders transcript_events by seq; compressed payloads reuse zstdChunks and verify declared byte length.
Cold archives and live restoration are outside that source selector.

Shared chatMessageEvents extends the existing messageEvents mapping for persisted OpenAI/Pi-style messages, native reasoning, tool results and usage.
Provider adapters retain responsibility for field aliases, timestamps and provenance.
The alternative of importing another provider's mapper would couple format owners; duplicating block mapping would create competing projections.
All additions use agent-session/v1 with additive provider IDs, source-format strings, subpath exports and opaque provider metadata; existing snapshots stay compatible; the scan SPI migration is defined above.
The format union, provider fixture manifest, source-import policy and installed-subpath smoke test enforce these additions.

## Dependency and ingestion decisions

Provider mapping belongs to the adapter and shared format helpers; a runtime library or live protocol client is an alternative acquisition layer outside this package's local read-only scope.
No OAR, ACP SDK or harness runtime dependency is installed.
All existing JSONL providers retain the shared bounded line framer and ingestion pipeline.
Per-stream parser factories add capture-local validation state and reset on every replay; they do not cache or merge transcript history.
The bounded OpenCode JSON-file reader is reused as shared/json-file.ts for metadata, rather than creating a parallel parser.

`@bufbuild/protobuf@2.16.0` supplies Antigravity's standard BinaryReader through its public /wire entrypoint.
It is pure JavaScript, has no runtime transitive dependencies or install lifecycle scripts, and uses Apache-2.0 plus BSD-3-Clause licenses.
The package's codec supports Node 22 without a native core, WASM, protoc or sidecar.
Provider-specific field selection is a partial observed schema mapping, not another wire parser: the library validates tags/lengths and skips unknown fields, while Huihua retains the original binary SQL columns.
A generated schema decoder would be preferable if an authoritative schema were available; none was confirmed.
A handwritten varint codec duplicates general infrastructure; protobufjs adds a larger dependency graph; live ACP replay executes a runtime and changes acquisition semantics.
The dependency and licenses are explicitly allowed by tools/policy.ts and imported externally by tsdown.

fixtures/provider-cases.json adds synthetic source fixtures with TypeScript snapshots, using the existing oracle and golden-update harness.
It does not create pretend historical compatibility baselines: fixtures/cases.json and its static v1 goldens remain immutable.
New provider exports, shared layer directions, source preservation, format/selector rejection, framing, cancellation and the installed package are executable checks.
The independent artifacts in fixtures/compatibility have pinned provenance, licenses and hash checks; tests/provider-imports.test.ts checks native facts through public provider contracts.
Those tests exercise all nine added providers, including plain/checksummed DeepSeek v0–v4, without requiring a sibling checkout or network access.
This establishes the tested mappings, not parity with another application's rendering, migration, branch selection or runtime behavior.
Provider completeness still requires review and real authorized historical samples.

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
ACP and Grok emit file_change only for explicit ACP diffs.
Checkpoints in other formats remain evidence rather than inferred historical diffs.

## Quality and release automation

[ci.yml](../.github/workflows/ci.yml) runs pnpm check on pushes, pull requests and a weekly schedule.
Its matrix checks the minimum Node 22.18.0 runtime on Linux and Node 24 on macOS; the weekly advisory job checks production dependencies.

[release.yml](../.github/workflows/release.yml) owns npm publishing from pushed v* tags in wibus-wee/huihua.
The tag must equal v followed by package.json.version before dependency installation or validation starts.
The workflow uses the pinned pnpm version, a frozen lockfile and the existing pnpm check pipeline, then packs the checked dist with pnpm without rebuilding.
The pack command retains pnpm's manifest cleanup and includes the MIT license; the installed-package check validates this same packing path.
Stable versions publish to latest; versions containing a prerelease suffix publish to next.
Update and commit package.json.version, then push its matching tag to release; an existing npm version cannot be overwritten.

The publishing job runs on a GitHub-hosted runner with contents: read and id-token: write.
Release actions are pinned to commits and release dependency caching is disabled.
An explicitly pinned npm CLI publishes the tarball with OIDC, using npm's documented trusted-publishing path rather than a stored NPM_TOKEN or another CLI's authentication behavior.
This changes release automation only; package exports and agent-session/v1 semantics are unchanged.
[npm's Trusted Publisher contract](https://docs.npmjs.com/trusted-publishers) owns authentication requirements and automatic provenance generation.

Configure the huihua package on npm with GitHub Actions, organization/user wibus-wee, repository huihua and workflow filename release.yml (filename only).
Leave Environment name blank because the publishing job has no GitHub environment.
If the form exposes allowed actions, enable direct npm publish.
The workflow must be pushed to GitHub before this binding can be used.
tools/policy.ts checks the workflow's trigger, repository, runner, permissions and empty environment binding alongside the existing architecture rules.
OIDC authentication and the actual upload can only be verified by a GitHub Actions release run.

Machine checks enforce import directions, sources/dependencies, type safety, fixture/golden
semantics and public package exports.
Review owns mapping completeness, fact-versus-inference,
private-schema compatibility, abstraction reuse and whether new API belongs in this data layer.
