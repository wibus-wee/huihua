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

### Candidate identification

[shared/ingestion.ts](../src/shared/ingestion.ts) owns the internal JsonlAdapter seam.
Roots may resolve asynchronously. accepts(path, candidate) is a cheap path filter;
identify({ path, roots, explicitFile, header, companions }) runs after bounded header and companion reads.
Returning false omits the candidate without a failure; returning identity fields certifies and overrides
provisional id/metadata.
Source and provider ownership remain fixed by the adapter.
Malformed physical header records remain in the prefix so Qwen cannot certify a later valid row as the head.
No identification hook runs during read, open, parse or stream; supplied evidence remains readable.
metadata receives a fileBacked context so a supplied provenance label cannot establish native directory facts.
Adapters without identify retain their existing discovery behavior.

Provider modules own certification policy.
Qwen directory candidates require exactly
<projects>/<project>/chats/<id>.jsonl or chats/archive/<id>.jsonl, a native ID filename and a matching first record.
An existing but empty QWEN_HOME/projects remains authoritative; a missing or non-directory child falls back.
Claude combines environment roots, conventional/XDG projects, `.claude*` sibling projects and Desktop/Cowork
`local_*/.claude/projects` trees; Desktop journals and unrelated JSONL are excluded.
Cursor has separate CLI transcript, IDE state.vscdb, chat store and ACP store families.
Directory candidates undergo path and bounded content checks; exact caller-supplied file roots remain
an explicit acquisition surface, including standalone historical OpenCode metadata.
OpenCode directory discovery requires matching filename/native identity and session metadata facts;
ses_ filenames are the current legacy shape, while older full directory/time metadata remains compatible.

This replaces overloading accepts with content checks.
A second discovery/parser framework was rejected:
the existing walker, source failure boundaries, bounded framer and provider mapping already own those concerns.
The seam is internal, adds no package export or public SPI requirement, and does not change agent-session/v1.
[Discovery regressions](../tests/behavior.test.ts) enforce layout, identity, bounds, environment isolation,
explicit file authority, companion failures and preservation of independent sources.

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

### Selective frame delivery

`OpenSession.select(selection)` is an optional public capability for file-backed JSONL handles.
The session contract owns `FrameSelection`; shared ingestion owns its implementation and each provider still owns native mapping.
`events` selects canonical event types, while `records: false` and `metadata: false` omit those frame kinds from delivery.
The optional `metadataKeys` selects existing top-level patch keys and suppresses patches with no selected key; omission retains complete patches, and `metadata: false` takes precedence.
Owner is the session contract and shared `Ingestion.patch`, with no provider-specific routing.
The Usage CLI selects `parentSessionId`, the only metadata-patch field its current projection consumes, retaining late lineage while avoiding unrelated timestamps/workspace delivery.
Alternatives were suppressing all metadata (loses late lineage) or adding a parallel usage reader (duplicates parsing).
This additive optional selector preserves existing calls and serialization; adapters ignoring it still deliver complete patches and produce the same report.
Native identity validation always runs before delivery selection; the demand-driven metadata decision below lets supporting mappers avoid constructing unrequested facts.
Fixture equivalence, late-parent/identity regressions, installed types and `tools/policy.ts` enforce the selected keys and compatibility boundary.
Diagnostics are always delivered, including malformed records, unknown semantics, identity conflicts and unmatched tool calls.
Selected event and record sequence numbers remain those of a full stream, so gaps are expected.
Selection preserves order and repeated IDs; it does not deduplicate, infer usage, choose branches or avoid parsing source JSON.
Each invocation opens a fresh source with the existing limits, cancellation, cleanup and provisional-prefix rules.
The shared parser still tracks metadata identity and tool lifecycle, but avoids constructing unselected event envelopes, emitting their frames, and converting unselected message content.
Record evidence is available when selected and remains complete in the existing full stream/snapshot APIs.

This optional method keeps existing providers and every default API compatible; adapters without the capability use their full stream in the Usage CLI.
SQLite, JSON snapshots and custom readers do not claim this optimized capability.
There is no change to agent-session/v1 or the Usage report schema, and no dependency is added.
Using `events()` would still normalize all events and lose diagnostics; a CLI-native parser would duplicate provider mapping.
Skipping metadata or tool tracking would lose identity checks and end-of-input diagnostics, so only their unwanted frame delivery is omitted.
Selection is introduced after profiling both usage-only and content-bearing synthetic fixtures; the Usage CLI owns its formatter reuse and aggregation optimizations.
Fixture equivalence/lifecycle tests and installed-package checks enforce this boundary together with the public-contract guard in `tools/policy.ts`.

## Direct acquisition

### JSONL forwarding and evidence allocation

Owner is the existing shared JSONL framer and ingestion pipeline.
The file chunk reader loads the existing binary module only for compressed sources, before creating the stream, and checks cancellation after the load.
This avoids unused hash/codec initialization for plain JSONL without changing zstd decoding or checksum ownership.
Alternatives were eager binary loading (visible initialization cost on the selected plain-JSONL CLI profile) or a separate plain/usage reader (duplicates ownership).
Selected-provider subprocess module-graph checks reject eager xxhash/fzstd imports; compressed fixture, cancellation and checksum tests retain the existing archive boundary.
The file helper returns `jsonLinesFrom(chunks(...))` directly instead of forwarding every native line through another async generator.
Both source generators remain lazy; the existing framer owns record limits and chunk cancellation, and `chunks` still owns file/zstd cleanup.
Ingestion passes the existing line as its text/byte evidence argument instead of reconstructing an equivalent temporary evidence object; it selects the same optional fields into each public record.
Alternatives were retaining the redundant forwarding/allocation, using a replacement decoder (a local Node Buffer validation/decode probe was slower), or adding a narrow usage parser (would duplicate provider ownership).
There is no new dependency, abstraction, public API or serialized field, and full native JSON/strict UTF-8 decoding remain unchanged.
Encoding/evidence tests compare file and acquired paths for Unicode/BOM, invalid sequences, exact numeric text and record positions; existing limits, cleanup, cancellation, golden and selective-report tests remain the compatibility boundary.
Complete before/after daily/model JSON equality is required before accepting performance results.

### Callback frame consumption

The session contract owns optional `OpenSession.consume(selection, consumer): Promise<void>` and `FrameConsumer`.
The existing shared JSONL ingestion pipeline owns its implementation: it drains the same per-record frames to a callback after mapping, rather than yielding/awaiting every frame through an async iterator.
The callback can return void or a Promise; only promised work is awaited, with the existing cancellation checks before and after every delivery.
Completion means successful EOF, including suffix validation and parser/tool diagnostics; callback throws/rejections and cancellation propagate and close the source.
Frame order, sequences, selected metadata/evidence, per-record mapping-before-delivery and provisional prefixes match `select` exactly.
Consumer callbacks own cancellation of their own pending work, as iterator consumers do.

Alternatives were a new usage parser (breaks provider ownership), batching through another mandatory iterator layer (changes default delivery and adds forwarding), or omitting callback errors/cancellation/EOF diagnostics (weakens the contract).
Profiling identified repeated per-line and per-frame iterator work as avoidable overhead in the reporting path.
`consume` is optional; existing and third-party handles need not implement it, and all existing APIs/default frames and `agent-session/v1` remain unchanged.
Usage uses this capability when present, otherwise existing select/full-stream fallback, without a private provider import.
Fixture/callback equivalence, async backpressure, error/cancellation cleanup, installed declarations and the optional-capability/public-consumer guards in `tools/policy.ts` enforce this boundary.
The same-worker selected/callback benchmark isolates delivery mode while before/after CLI JSON and ccusage counters remain required comparison gates.

### Evidence-free usage consumption

The session contract owns optional `OpenSession.consumeUsage(consumer)`; shared ingestion owns delivery and each supporting provider owns the native context attached to its existing Usage event.
This is an extension of the same parser, not another provider parser or an incomplete RawRecord projection.
It delivers only Usage events, parentSessionId patches and all existing diagnostics, with the same sequences, UTF-8/JSON validation, limits, identity checks, tool tracking, cancellation and EOF behavior.
Usage events additionally carry `providerMetadata.native_usage_context`: Claude supplies same-record `model`, `message_id` and `request_id`; Codex supplies same-record `model` (response identity remains in its native usage payload).
Missing facts stay absent; context does not establish token arithmetic, deduplication or billing.
The shared ingestion cursor retains native data needed by the mapper, but only constructs a complete RawRecord and its text/byte evidence fields when records are requested.
The Usage CLI prefers this optional capability and otherwise uses consume/select/stream with complete records.
Only Claude and Codex advertise it; other providers must establish all required model, identity and branch facts before opting in.

Alternatives were dropping records without moving their required facts to the provider (loses model and duplicate diagnostics), changing default canonical events (breaks static goldens), or adding a private CLI parser (duplicates format ownership).
Existing stream/select/consume/snapshot serialization and agent-session/v1 remain unchanged; only the opt-in usage method adds these context metadata keys.
The report schema and token rules remain unchanged, and no dependency is added.
JSON.parse still validates and decodes a complete row: evidence-free consumption does not claim selective JSON decoding.
Maintained selective JSON codecs must be measured before adoption; smaller objects alone do not establish a faster complete report.
Provider fixture/report equivalence, callback lifecycle tests, installed declarations and executable policy checks enforce the capability and ownership boundary.
The private CLI runner's optional delivery boolean belongs to Usage validation, not a user flag or public Huihua API.
The harness generates a small ESM entry calling the same `run` with callback disabled to isolate actual CLI delivery using the same built package; it records the wrapper and its small additional module-loading cost.

### Compiled Usage executable

Owner is `packages/usage/tsdown.config.ts` and the private Usage package's build/bin/start scripts.
Maintained sources remain TypeScript; the already pinned root tsdown tool emits the CLI's disposable JavaScript into its own dist directory.
Huihua and every public subpath remain external dependencies, so the CLI does not bundle provider parsers or become a second composition owner.
Root build first emits Huihua, then builds the CLI; type-aware lint and tests use those public declarations and the actual compiled executable.
Alternatives were retaining runtime TypeScript stripping (the selected CLI profile attributes about 11 ms to Node's internal Amaro initialization), adding a second compiler (unnecessary dependency), or bundling Huihua (weakens public-contract ownership and selective module loading).
Only private executable/build paths change; no dependency, Huihua SPI or report fields change.
Architecture checks enforce bin/scripts and external public imports; subprocess regressions exercise the built executable, and the benchmark hashes the emitted CLI and compares its full report to the previous source executable.
Benchmark generation/building remain outside complete-output timings, as with the prebuilt ccusage binary.

### Four usage optimization experiments

The session contract owns optional `consumeUsageFacts(consumer, options)` and compact `UsageFact`/`UsageFactConsumer` types.
Shared Ingestion routes the existing provider's Usage mapping to compact facts instead of constructing a canonical event plus frame; metadata/diagnostics retain their original order and EOF guarantees.
Only providers already supplying complete native usage context advertise it.
The Usage builder shares its existing arithmetic and confidence code across facts and canonical events; there is no additional provider projection.
Alternatives were removing provenance/diagnostics (changes trust), creating CLI parsers (duplicates ownership), or retaining unnecessary canonical envelopes (the measured profile shows allocation/ingestion work).
Existing default frames, optional consumeUsage, agent-session/v1 and report JSON remain compatible; this is an additive optional capability.

The ReadOptions contract and shared JSONL framer own optional `batchDecode` (JSONL only).
The experiment decodes at most 256 KiB of complete lines already in the current acquired chunk, then parses each original physical row with the existing JSON.parse.
Spanning lines and invalid UTF-8 batches use the original per-line decoder; per-line BOM behavior, original text/bytes, blank positions and byte limits remain unchanged.
There is no additional source read ahead, row array, parser, dependency or unbounded materialization.
Alternatives were larger whole-file buffers (memory/provisional-prefix costs), a new codec (the evaluated selective library was slower), or keeping per-row TextDecoder calls.
Decode selection changes only acquisition work, not native values, error positions, delivery, cancellation or evidence semantics.
This measured prototype remains explicitly opt-in (`batchDecode: true`), including in the private benchmark runner; the CLI does not enable it automatically because most measured cases regress.

Optional `UsageFactOptions.acceptTimestamp` is a synchronous consumer-owned predicate over the same native normalized timestamp.
It runs after framing/JSON/identity validation and tool tracking, before usage context/event-envelope construction; rejected usage still contributes to parser sequence bookkeeping and all source diagnostics remain active.
The Usage builder owns date/timezone/DST rules and accounts excluded undated observations; it reuses the accepted date when consuming the fact.
Alternatives were filtering on source mtime/session start (unsafe across dates), moving calendar policy into providers (wrong owner), or repeated date parsing after acceptance.
The predicate cannot skip native validation or source EOF and introduces no inferred time/model or serialization changes.
The Usage runner automatically chooses compact facts plus this predicate only when explicit `since` and `until` name the same calendar day.
An unbounded or multi-day report keeps evidence-free canonical consumption: compact envelopes alone did not show consistent gains across the tested fixture workloads.
This conservative query-shape decision belongs to the consumer, not to provider discovery or native parsing; it is not a general speed guarantee.

The private Usage runner owns a bounded scheduling experiment (one, two or four files).
It opens references in scan order, groups incremental handles only, serializes buffered handles, and awaits every started read before returning or throwing.
Sibling reads are aborted on failure and no partial final JSON is printed.
The builder's per-session state and sorted final output retain deterministic sums, cross-source duplicate diagnostics and provenance despite interleaved delivery.
Alternatives in that experiment were unbounded Promise.all (memory/file-descriptor costs), workers/native execution (then outside scope), or parallel buffered snapshots (retains multiple large native objects).
Concurrency remains serial by default because small-file gains are inconsistent and worker memory costs are substantial.
Two/four-file controls and batch decoding remain explicit, tested benchmark prototypes rather than user flags; all four candidates are reproducible through the same maintained harness.
The maintained harness compares complete reports, first-result latency and process peak memory; generation/building remain outside output timings.
These tuning options belong to the private benchmark runner, not new user-facing CLI flags; production defaults depend on full-output measurements.
Executable policy, installed types, fixture/report equivalence, decoder boundaries, callback cleanup and concurrency/failure regressions enforce each owner and compatibility boundary.

### Demand-driven metadata and CPU worker experiment

Shared JSONL ingestion owns passing existing FrameSelection metadata keys as the fourth argument to the existing adapter metadata function.
The third argument retains the fileBacked acquisition context used by Kimi; async discovery roots and certified provider discovery remain intact.
Claude and Codex own honoring that optional internal argument inside their current mapper; native ID extraction always runs for identity validation, regardless of requested delivery keys.
Workspace/title/createdAt/metadata extraction and shared updatedAt patch construction can be omitted before allocation when they are not requested.
The other adapters keep their current mapper and ignore the optional argument; default discovery/full streams and every serialized core field remain unchanged.
The existing public metadata selector is sufficient: no new public API, parser or dependency is introduced.
Alternatives were filtering only after allocation (current measured overhead), skipping identity checks (changes trust), or creating another metadata parser (duplicates provider ownership).
Default selection equivalence, foreign identities, late lineage, full snapshots and immutable goldens remain compatibility checks.
The internal ingestion cursor keeps provider identity and returns the original default RawRecord handle so Cursor persisted graph edges can associate previously ingested evidence without copying rows.
Evidence-free selections omit type/text/bytes and record-frame construction; default record evidence and graph associations remain unchanged.

The explicitly requested CPU-parallel experiment belongs only to the standalone Usage consumer, not Huihua's provider runtime or observe.
Node worker_threads runs the same emitted TypeScript consumer and public provider contracts in bounded two/four worker partitions; there is no sidecar, native core, network ingestion or provider-owned scheduler.
Each reference is read sequentially to EOF inside one worker; workers return private compact accumulator partitions rather than records/events or source bytes.
The existing UsageReportBuilder owns exporting/importing these partitions, including sticky overflow state, partial flags, diagnostics, token groups and identity-to-session associations.
All totals and report serialization still use its original arithmetic; parent merges partitions in original reference order and restores cross-partition duplicate diagnostics without deleting observations.
The private usage-partition/v1 structured-clone transport is not a public report/storage format and never invents provider facts.
Workers use public selected provider modules; parser implementations remain external in emitted artifacts.
Errors cancel siblings, await worker exits, and print no partial report; buffered providers stay on the serial consumer path.
Alternatives were Promise-only concurrency (does not parallelize CPU), transferring every usage event (clone/queue overhead), merging finalized numeric reports (loses overflow and cross-source identity evidence), or adding native/foreign execution (outside constraints).
Worker startup and per-isolate memory must be included in full-output and process-wide RSS measurements; one file and buffered fallback remain serial.
Repeated identical source selectors also fall back to serial reads so native repeated acquisitions are counted rather than discarded or rejected by partition merging.
Private worker-count controls stay off by default until an identical-report benchmark establishes a useful workload and memory tradeoff.
A repeated large-file comparison supports an explicit CLI --workers 1|2|4 option, owned by Usage argument parsing and scheduling; the default remains one because worker RSS and small-file startup costs are substantial.
The alternative of automatic file-count/size thresholds would extrapolate beyond the available fixture measurements.
This additive command option changes execution only, not discovery facts, token arithmetic, report filters/schema, public Huihua APIs or dependencies; private benchmark overrides still isolate each mode.
Usage argument parsing also accepts one leading -- forwarded literally by pinned pnpm 12; a focused regression reproduces the old error before the fix and verifies the compiled executable.
This affects runner argument transport only and introduces no report/schema/provider change.
Executable architecture checks enforce public imports, emitted worker entry, bounded counts, compact partitions and sibling cleanup; fixture and adversarial partition regressions enforce trust and overflow semantics.
The CLI build has a separate worker entry and may share emitted chunks; its main-thread entry guard recognizes the actual cli.js path without launching another CLI inside a worker.
Comparisons use the emitted consumer and a preserved baseline where available.
Measurements use fixture-derived inputs and include worker isolates in process peak memory.
The actual emitted CLI accepts bounded --workers 2/4 options; single-file input remains serial.

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

| Provider    | Source and discovery                                                                                  | Mapping boundary                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| claude      | Combined CLAUDE_CONFIG_DIRS/CLAUDE_CONFIG_DIR, conventional/XDG and .claude* projects; Desktop/Cowork | Native Claude JSONL; no inference of workspace or lineage from directory names                       |
| cursor      | IDE global/workspace state.vscdb; .cursor/projects agent-transcripts; .cursor/chats and acp-sessions  | IDE rows and confirmed persisted text graph; private steps and unreferenced blobs remain evidence    |
| oar         | Explicit voyage/3 or RawEvent JSONL; no default directory                                             | Recorded OAR projections for any harness; complete wrappers/native payloads retained                 |
| acp         | Explicit JSON-RPC or bare SessionNotification JSONL; no default directory                             | Stable v1/v2 updates; no universal ACP export archive or live connection                             |
| kimi        | KIMI_CODE_HOME/sessions or ~/.kimi-code/sessions; each agents/*/wire.jsonl                            | Confirmed flat durable wire records and companion state.json; no Python kimi-cli or ZIP decoder      |
| grok        | GROK_HOME/sessions or ~/.grok/sessions; updates.jsonl                                                 | Standard ACP updates and summary.json; unmapped xAI extensions remain unknown                        |
| antigravity | AGY_CONVERSATIONS_DIR or ~/.gemini/antigravity-cli/conversations; *.db                                | Partial observed CLI steps schema; no guarantee for Google's separate ACP-server/IDE store           |
| morph       | MISTER_MORPH_FILE_STATE_DIR or ~/.morph; stats/topics_projection.json and journal/events.*.jsonl      | Current topic/task journal; repeated snapshots retained; custom config paths use explicit roots      |
| copilot     | ~/.copilot/session-state; flat JSONL and events.jsonl                                                 | Native messages, mirrored tool requests/execution and usage; no quota accounting                     |
| hermes      | HERMES_HOME or ~/.hermes; state.db and historical sessions                                            | All selected SQLite rows, JSON snapshots and JSONL captures/exports; no routing/index ingestion      |
| openclaw    | OPENCLAW_STATE_DIR/agents or ~/.openclaw/agents and legacy ~/.clawdbot/agents                         | Selected session_windows/transcript_events, Zstandard payloads and legacy JSONL; no cold restoration |
| qwen        | Existing QWEN_HOME/projects or ~/.qwen/projects; certified chats[/archive] JSONL                      | Native Google parts, usage and system subtypes; telemetry excluded, malformed data never repaired    |
| devin       | Absolute XDG_DATA_HOME or ~/.local/share; devin/cli/sessions.db                                       | All selected message nodes; native chain order and branch markers; no inferred usage                 |
| fx          | ~/.fx/sessions; session.json and checkpoint.json                                                      | Manifest-3/checkpoint-1 history snapshots; post-checkpoint event tail diagnosed                      |
| cline       | ~/.cline/data/sessions; <id>.json and adjacent <id>.messages.json                                     | Version-1 CLI/Desktop messages, metrics and surface; external paths never followed                   |
| deepseek    | DSH_HOME/sessions or ~/.dsh/sessions; session[.vN].jsonl[.zstd]                                       | Highest immutable generation, known v0–v4 facts; no migration or surface replay                      |
| droid       | ~/.factory/sessions and ~/.factory/projects; JSONL                                                    | Legacy stored messages and stream-json captures; no current private-store certification              |

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

Shared pathMatcher uses [picomatch](https://github.com/micromatch/picomatch) 4.0.7 for fixed,
provider-owned directory layout globs.
Qwen, Claude Desktop and Cursor reuse this matcher;
Node path.relative owns root containment and native separators are normalized only for matching.
Hidden directories remain eligible, caller roots are literal paths rather than glob patterns,
and paths outside an asserted root are rejected.
Native source paths and public APIs stay unchanged.
Picomatch is pure JavaScript, MIT licensed, with no runtime dependencies or install scripts;
its types are development-only and tsdown keeps the runtime package external.
[Executable policy](../tools/policy.ts) reviews both dependencies.
Handwritten glob or separator logic duplicates general infrastructure.
Node path.matchesGlob is
experimental on the minimum Node 22.18 runtime; a filesystem glob walker would replace our existing
source failure, ordering and symlink contracts unnecessarily.
Pathe's cross-platform normalization
would reinterpret legal POSIX backslashes.
Env-paths allocates an application's own conventional
directories: its Config/Preferences layouts and default nodejs suffix do not describe native Agent stores,
and its captured home directory cannot preserve per-call homeDir isolation.
Providers therefore retain ownership of native system directory names and environment precedence;
Node homedir/path/fs already supply the required filesystem behavior.
Focused tests enforce hidden/literal roots, exact layouts, containment and POSIX backslashes.

Cursor's provider-owned [persisted store reader](../src/providers/cursor/persisted.ts) reuses SqliteReader,
Ingestion and the installed @bufbuild/protobuf wire reader.
Node crypto owns SHA-256 content-address validation;
Node realpath owns static symlink/ancestor checks for ACP stores and sidecars.
[Executable policy](../tools/policy.ts) permits those read-only platform APIs, with no new dependency.
Scanning validates bounded native metadata and the root blob, without parsing conversation turns.
Reading buffers the blob table, walks confirmed graph edges in recorded order, and retains every native row,
including unknown private variants and unreferenced history.
Repeated graph edges emit repeated events;
Ingestion.record returns its evidence handle and associate selects that existing handle rather than copying a row.
Synthetic SQL/graph fixtures and repeated-reference assertions enforce the evidence contract.
Missing referenced nodes, invalid content addresses and malformed known graph fields fail explicitly.
ACP schemaVersion 1 sidecars supply cwd; a UUID directory must match native agentId.
Symlink descendants are excluded by the walker and static ACP pathname checks also reject symlink roots/sidecars.
These checks are not descriptor-bound protection against adversarial path replacement; reads retain the existing
SQLite fingerprint/WAL validation and no atomic snapshot claim.
User stores are never copied or written.
Chat and ACP are additive cursor_sqlite locator.storage values; modern and legacy IDE locators retain their behavior.
Grok updates.jsonl, Kimi physical streams and Antigravity CLI evidence surfaces remain unchanged.

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

## Local usage report

### Usage startup and allocation decision

Owner of `huihua/registry` is the existing provider-independent `src/registry.ts`.
This additive package entrypoint exports the same `SessionRegistry` and `createSessionRegistry` as the root, without composing builtins.
Owner of selected-provider loading is the Usage CLI: explicit `--provider` values load only their existing public provider subpaths and compose the existing registry.
Without a provider filter the CLI uses the root's complete builtin registry.
The consumer's loader list mirrors published provider exports, contains no parsers or discovery roots, and is checked against that export inventory.
Alternatives were retaining eager root imports (a measured avoidable startup cost) or making the global registry lazy (a broader API/lifecycle change).
Root exports, provider SPI, native parsing, ordering, diagnostic behavior and serialized report fields remain compatible.
Installed-package checks verify entrypoint identity and types; subprocess module-graph checks reject unselected providers and compare reports with the complete registry.

The Usage builder owns allocation reduction: UTC uses its existing ISO-day rule without constructing an unused Intl formatter, reuses the current UTC day/group, and allocates embedded model lookup only for Cline records that need it.
Missing counters still use null, identity checks retain duplicates, and non-UTC dates retain Intl's timezone/DST behavior.
Alternatives were changing the parser or bypassing metadata/diagnostic work, which the profile does not justify and which would weaken evidence checks.
These changes introduce no dependency, provider mapping, public contract or report-schema change.
The benchmark can run a caller-supplied previous CLI against the identical temporary inputs; every complete Huihua JSON output must match before before/after timings are accepted.
The optional baseline layout preserves the consumer package.json, adjacent CLI/report/options sources and its own `../node_modules/huihua` installed package; consumer/core package, source and built-file hashes are recorded.

### Daily totals and model attribution decision

`packages/usage/src/report.ts` owns the daily/model/session report projection, its provider-specific arithmetic, confidence labels and `huihua-usage/v2` output.
The CLI consumes public evidence-free usage context when supported, otherwise native record and usage frames; the fallback keeps only the current record of the active session for same-record model attribution.
It never reads source bytes independently or decodes a second copy of a provider format.
The private builder's `end(ref)` releases record/model/branch scratch state after each completed source while keeping compact totals and identity diagnostics; a buffered JSON snapshot must not remain retained across completed sources.
The CLI, fixture helper and benchmark workers use this boundary, and `finish()` also releases remaining scratch state.
A lifecycle regression checks that ended record facts cannot attribute subsequent recordless usage; `tools/policy.ts` requires the CLI's release call.
No public Huihua contract or report field changes are needed for this lifecycle fix.
Buffered sources may also supply a same-record assistant model or OpenCode `message_metadata` fact through their existing public events.
Models absent from those facts use an explicit null/unknown bucket, never a session-wide last-model guess.
The selective fallback includes records for attribution and omits unselected message content conversion; Claude/Codex consumeUsage instead supplies provider-owned context without native records.

The report sums validated nonnegative safe-integer token counters into inclusive local-calendar daily rows, model breakdowns and session totals.
Null means a component is unavailable; numeric partial totals sum only known components and are labeled partial.
Claude's cache counters are additional to input/output; Codex cached input and reasoning output are subsets and are never added twice.
Other provider-specific equations and unsupported shapes are listed in `usage-report.md`.
Repeated evidence is not deleted: repeated response identities and fork/replay uncertainty invalidate completeness while preserving the reported native-record sum.
Cumulative checkpoints without safe per-request allocation are excluded from additive totals with diagnostics.

Alternatives were retaining the observation-only report (does not meet the requested daily report), applying ccusage's deduplication heuristics globally (would assert unsupported provider semantics), and adding model/billing fields to canonical provider events (changes serialized session semantics and goldens).
Public record associations plus existing normalized facts meet this report's attribution needs without a new parser, dependency or core schema field.
The private CLI's JSON intentionally changes from observation-only v1 to daily/model v2; Huihua's provider SPI, `agent-session/v1`, public selection API and static compatibility goldens are unchanged. `tools/policy.ts` checks the report schema and public-only/no-source-I/O boundary; fixture-backed report and subprocess tests enforce arithmetic, attribution, partial/unavailable values and full-stream equivalence.

`packages/usage/tools/bench.ts` is owned by Usage validation.
It generates temporary fixture-derived inputs, runs public-contract full/selected workers, the actual CLI and a caller-supplied ccusage binary, and verifies identical daily/model counters before retaining timings.
It records complete-output/first-byte time, sampled child peak RSS, versions, input/source hashes and repetitions.
The alternative of untracked JavaScript experiments cannot reproduce the final daily-report comparison.
The maintained harness is TypeScript, uses Node APIs and existing dependencies only, and is not run by ordinary `pnpm check`; its package command and public Huihua imports are checked by `tools/policy.ts`.
Its isolated HOME/config roots contain generated fixtures only; runtime source reading still belongs to Huihua.
No benchmark input or binary is added to the production package.

The optional [`@huihua/usage` CLI](usage-report.md) is a separate workspace consumer of the published `huihua` package.
It destructures the public `sessions.scan()` result and rejects any discovery failures before opening sources or emitting a report; otherwise a damaged or denied store could silently disappear from totals.
The alternative is a new report-level scan-failure schema with explicit incomplete coverage, which is deferred; existing successful report serialization is unchanged.
The CLI owns this strict failure policy, and executable checks plus a mixed readable/corrupt-store subprocess regression enforce it.
It discovers through `sessions.scan()` and prefers optional `sessions.open(ref).consumeUsage()`, then consume/select/full-stream fallbacks, aggregating daily/model token totals and diagnostics without retaining event arrays or collecting a complete Session.
Provider-specific storage and mapping remain owned by `src/providers/<id>`; no second parser, projection API or provider identity logic is added to `src/shared` or `src/observe`.

The CLI owns report filters, provider-specific token arithmetic, model attribution and rendering.
Native usage semantics remain provider-owned and evidence-backed in each `RESEARCH.md` and fixture.
It sums supported native counters into daily/model/session token totals with explicit confidence and unknown buckets; it does not turn unsupported cumulative scopes into per-request work or costs into actual spend.
Repeated IDs, cumulative snapshots, replay and branches remain.
Undated usage does not inherit session timestamps.
The matrix and per-provider handling are specified in <usage-report.md>.

The report layer does not change provider SPI, `agent-session/v1`, native formats, runtime dependencies or serialized sessions; the additive registry export and selection keys are specified above.
Owner is `packages/usage` for CLI policy and report labels; alternatives were adding billing semantics to the shared schema or duplicating parsers, both of which would weaken evidence ownership and compatibility. `tools/policy.ts` verifies the workspace member, private package dependency, and public-package-only Huihua integration.
The standalone package adds a workspace link to Huihua only, so consumers continue to use the existing pinned pnpm graph.
`pnpm check` builds Huihua before type-aware lint and strict typechecking so the CLI's public imports resolve against emitted package declarations from a clean checkout or after a core API change, then runs the CLI's `--help` smoke check against the built public package.

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
