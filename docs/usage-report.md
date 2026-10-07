# Local usage report

`@huihua/usage` is a standalone workspace CLI.
It discovers through public `sessions.scan()` and streams public `sessions.open(ref)` frames.
Any reported discovery failure produces a nonzero exit with diagnostics and no report, even when other sources are readable; incomplete source coverage must not look like complete daily totals.
Claude and Codex expose optional `consumeUsage`: the same provider parser supplies Usage events with same-record model/identity context, parent-lineage metadata and all diagnostics, without constructing or delivering complete native records.
An explicit single-day query (`since` equals `until`) uses their optional direct usage facts and consumer-owned date predicate, bypassing canonical usage envelopes and excluding dates before context allocation.
Other providers retain callback consume/select/full-stream delivery with records for attribution, avoiding unselected message normalization where supported.
The native JSON decoder is still active; this capability removes evidence construction/delivery, not complete JSON decoding.
Explicit provider filters compose the existing registry through `huihua/registry` and load only selected public provider subpaths; unfiltered discovery still covers all builtins.
The report retains only the active session's current record, compact daily/model accumulators and response identity keys, not all records or events.
Completed sources release their native record and model scratch state; this also prevents retaining whole buffered JSON snapshots across sources.

After `pnpm build` emits Huihua and the standalone CLI, run:

```sh
pnpm --filter @huihua/usage start -- --provider claude --since 2026-01-01 --until 2026-01-31 --timezone America/Los_Angeles --json
```

The default text output is a daily token table with model rows and grand totals: input, output, cache creation, cache read and total tokens.
JSON `huihua-usage/v2` contains `daily`, `totals`, provider summaries and per-session `daily`/totals with the original source selector.
Each day includes `modelsUsed` and `modelBreakdowns`; each model row carries its provider.
There is no project breakdown.

Dates are inclusive local calendar dates, UTC by default; repeat `--provider` to select multiple providers.
Optional `--workers 2` or `--workers 4` enables CPU-parallel reading of different JSONL sessions, with greater memory use; default `--workers 1` is serial.
Single-file input, buffered stores and repeated identical source selectors stay serial.
Missing/invalid native times use a null-date bucket when unbounded and are excluded when either date bound is present, with an explicit undated count.

Token counters must be nonnegative safe integers.
Null means unavailable, not zero; numeric partial totals add only the known components.
Completeness describes the mapped native counters and their attribution, not a bill or deduplicated physical workload.
Unsupported/cumulative usage can therefore coexist with useful daily totals without being silently counted as zero.
The previous observation-only `huihua-usage/v1` CLI shape was unreleased and did not meet the daily-report requirement; it is replaced rather than retained as the default product.

## Provider usage evidence matrix

“Native usage” means a Huihua provider currently emits a canonical `usage` event from an observed source record or a shared public mapping.
It does not certify every product version or store.
Units below describe fields only where the implementation/research and checked-in fixture establish them.
The following inventory records available evidence.
The arithmetic table below specifies which fields enter the daily report; native usage presence alone does not establish additive tokens or billing semantics.

| Provider         | Native usage                   | Native fields / units evidenced                                                                                                                                                    | Repetition, accumulation, replay, branches                                                                                                                 | Reliably reportable                                                                                              |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Claude           | Yes                            | `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` are token counters; nested `iterations[]` are preserved                                  | Split assistant records may repeat IDs and usage; nested advisor usage has a separate model and scope, so Huihua does not fold it into outer values        | Input/output/additional cache sums; explicit advisor model contributions; partial on missing counters or repeats |
| Codex            | Yes                            | `usage.input_tokens`/`output_tokens`; `token_count.last_token_usage` and `total_token_usage` snapshots, token counters                                                             | Repeated response IDs; request usage records and cumulative/last snapshots coexist. Huihua and RESEARCH explicitly forbid dedupe and delta inference       | Request input/output totals with cached input as a subset; cumulative snapshots excluded                         |
| Cursor           | No                             | No provider usage event mapping                                                                                                                                                    | Database schemas contain message/part rows; no usage mapping is established by current implementation/fixtures                                             | Token totals unavailable                                                                                         |
| OpenCode         | Yes                            | `tokens.input`, `output`, `reasoning`, `cache.read`, `cache.write`; native `cost` field                                                                                            | Fork/session-v2 boundaries and copied history are retained; rows may be buffered and historical schemas vary. Cost unit/currency is not attached by Huihua | Message token sums; partial on missing/reasoning/fork scope; step-finish excluded                                |
| Pi               | Yes                            | Native `usage.input`, `output`, `cacheRead` and `cost.total`; fixture also proves string/null values                                                                               | Tree branches and replay-prefix observations are retained; repeated values are not removed                                                                 | Numeric input/output/additional cache or native total; branches and replay partial                               |
| ACP              | Yes                            | `usage_update` update object including `used` and `size`; protocol counters have no token unit asserted here                                                                       | Chunks, request/echo and complete upserts are separate observations                                                                                        | Token totals unavailable: context capacity is not additive usage                                                 |
| Antigravity      | No                             | No usage mapping; partial observed private CLI SQLite subset                                                                                                                       | Private database support itself is partial                                                                                                                 | Token totals unavailable                                                                                         |
| Grok             | No                             | Grok extensions are unknown; no usage inferred from prose                                                                                                                          | Updates may be rewritten by rewind; authoritative update log is read without folding history                                                               | Token totals unavailable                                                                                         |
| Kimi             | Yes                            | `usage` object on messages and `usage.record` payload with optional model and `usageScope`; fixture has no authoritative common unit contract                                      | Distinct per-agent streams, partial messages and explicit usage records remain separate                                                                    | Explicit token-named partial sums or native total; no universal counter scope                                    |
| OAR              | Yes                            | Recorded `usage` payload; fixture shows `tokens.input` and `tokens.output`                                                                                                         | Frame order, agent path and span are evidence; repeated frames are not merged                                                                              | Explicit input/output partial sum; cross-runtime scope unknown                                                   |
| Morph            | No                             | Snapshot/task journal has no mapped usage event                                                                                                                                    | Journal includes repeated task snapshots, intentionally retained                                                                                           | Token totals unavailable                                                                                         |
| Copilot          | Yes                            | `assistant.usage`, `session.usage_checkpoint`, and shutdown `modelMetrics` payloads; fixture has `inputTokens` and `outputTokens`                                                  | Checkpoint versus per-response scope is native; Huihua does not infer deltas                                                                               | Response input/output partial sum; checkpoint/shutdown scopes excluded                                           |
| OpenClaw         | Yes                            | Pi-style message `usage` object; fixture contains `input` and `output`                                                                                                             | Transcript branches and repeated message IDs are retained                                                                                                  | Pi-style numeric sum or native total; branch/replay completeness partial                                         |
| Qwen             | Yes                            | Google `usageMetadata`, fixture has `promptTokenCount`; Google usage metadata token counters retain native names                                                                   | Repeated UUIDs/records remain; only present fields are known                                                                                               | Native total or partial prompt/candidate sum; cached input is a subset                                           |
| Droid            | Yes                            | Completion `usage` object; fixture coverage verifies native retention but not a stable common field/unit set                                                                       | Completion events are retained as observations; no record dedupe                                                                                           | Additive tokens unavailable until field/unit semantics are evidenced                                             |
| DeepSeek Harness | Yes                            | `data.usage` object; fixture shows `inputTokens`                                                                                                                                   | Surface operations and sequence facts are retained; no delta or retry removal rule is evidenced                                                            | Native total or partial input/output sum; cache/replay scope uncertain                                           |
| Cline            | Yes, when present              | Shared chat mapping emits `usage` or `metrics`; fixture `metrics.inputTokens`                                                                                                      | Repeated message IDs can occur; source JSON snapshots and adjacent messages remain intact                                                                  | Partial token sum with same-record model attribution; cache overlap uncertain                                    |
| fx               | No                             | Manifest/checkpoint records do not map usage                                                                                                                                       | Checkpoint tail behavior is diagnosed; no usage inferred                                                                                                   | Token totals unavailable                                                                                         |
| Devin CLI        | Conditional native fields only | Shared chat mapper emits only explicit message `usage`/`metrics`; no stable Devin usage fields are evidenced. Research rejects zero cost placeholders and context cursors as usage | Main chain and off-chain nodes are preserved; branch membership may be ambiguous                                                                           | Additive tokens unavailable; no established counter contract                                                     |
| Hermes           | Conditional native fields only | Shared chat mapper emits explicit `usage` or `metrics`; no universal Hermes counter schema is asserted                                                                             | Inactive/compacted rows and historical snapshots remain in source order; possible replay cannot be safely removed                                          | Additive tokens unavailable; no established counter contract                                                     |

Evidence pointers: provider behavior is owned by `src/providers/<id>/RESEARCH.md` and `src/providers/<id>/index.ts`; shared chat-shaped mappings are in `src/shared/ingestion.ts`; ACP's mapper is in `src/shared/acp.ts`.
Relevant native examples include `fixtures/claude/usage-only.jsonl`, `fixtures/codex/usage-records.jsonl`, `fixtures/pi/usage-variants.jsonl`, `fixtures/copilot/session/events.jsonl`, `fixtures/opencode/simple.sql`, `fixtures/cline/session/session.messages.json`, `fixtures/qwen/session.jsonl`, `fixtures/droid/session.jsonl`, `fixtures/oar/voyage.jsonl`, `fixtures/openclaw/session.jsonl` and the per-provider fixture manifest.
The generic `usage` event alone is not evidence that other providers share these fields.

## Daily arithmetic and model rules

| Provider                             | Daily token rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Model evidence / limitations                                                                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude                               | Sum `input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Missing components remain null with a numeric partial sum. Cache creation tiers are summed only when the top-level creation counter is absent and both tier counters exist; disagreement with a present top-level counter marks the result partial without adding both. Explicit `advisor_message` iterations are separate contributions; ordinary `message` iterations are not added again. | Same-record `message.model`; advisor iteration's own model. The empirical advisor rule is supported by the pinned ccusage Claude adapter cited in provider research, not a universal public transcript guarantee. |
| Codex                                | Request `usage.input_tokens + output_tokens`, or explicit `usage.total_tokens`. `cached_input_tokens` is a displayed input subset; reasoning is an output subset. Cumulative/last `token_count` snapshots are excluded with a diagnostic because safe request/day allocation is not established.                                                                                                                                                                                         | Usage payload `model`; no last-model or session-metadata guess.                                                                                                                                                   |
| Pi                                   | Sum numeric `input + output + cacheWrite + cacheRead`, or explicit `totalTokens`. Strings/nulls are not coerced. Parent-session replay and multiple branches make totals partial.                                                                                                                                                                                                                                                                                                        | Same-record `message.model`.                                                                                                                                                                                      |
| OpenClaw                             | Same Pi-style numeric fields and native `totalTokens`; retain all recorded branches.                                                                                                                                                                                                                                                                                                                                                                                                     | Same-record message model, or matching same-record normalized assistant model for buffered sources; absent facts are unknown.                                                                                     |
| OpenCode                             | Message-level `tokens.input/output/cache.write/cache.read`; reasoning/output overlap is unestablished in the available evidence, so reasoning is not added, and nonzero/missing reasoning makes totals partial. `step-finish` counters are excluded because they may overlap message totals.                                                                                                                                                                                             | Public record's already-decoded `data.modelID` or `data.model.id`; no SQL/JSON payload is decoded again by the report. A part-only usage source can remain unavailable.                                           |
| Qwen                                 | `promptTokenCount`, `candidatesTokenCount`, cached input subset `cachedContentTokenCount`; prefer native `totalTokenCount`, which can include thought/tool counters not represented in displayed components. Without that total, input/output sum is partial.                                                                                                                                                                                                                            | Same-record `model`.                                                                                                                                                                                              |
| Copilot                              | Only `assistant.usage` input/output counters enter a partial sum. Cache fields can be displayed but their overlap is not established, so they are not added. Checkpoint and shutdown metrics are excluded.                                                                                                                                                                                                                                                                               | Explicit usage `model`; an unrelated assistant message is not carried forward.                                                                                                                                    |
| DeepSeek                             | Token-named `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens` are displayed; prefer explicit `totalTokens`, otherwise input/output partial sum. Cache additivity and replay/surface scope are not universally certified.                                                                                                                                                                                                                                                       | Same-record `data.message.source.model`; no request-header guess.                                                                                                                                                 |
| Cline                                | Same explicit token-named fields; native total if present, otherwise partial input/output sum. Cache overlap remains unknown.                                                                                                                                                                                                                                                                                                                                                            | Embedded message `modelInfo.id`/`model` only when its usage object is exactly associated with the same native record, or matching normalized assistant facts; repeated IDs alone do not select a message.         |
| Kimi                                 | Explicit token-named fields in native usage, native total if present, otherwise partial input/output sum; scope varies by recorded usage kind.                                                                                                                                                                                                                                                                                                                                           | Usage model, `providerMetadata.model`, or same-record native model.                                                                                                                                               |
| OAR                                  | Recorded `tokens.input/output` enter a partial sum; cross-runtime counter/replay scope is unknown.                                                                                                                                                                                                                                                                                                                                                                                       | Only explicit usage/provider metadata model; requested header model is not an assistant model.                                                                                                                    |
| ACP                                  | Unavailable: `used`/`size` context capacity is not additive token usage.                                                                                                                                                                                                                                                                                                                                                                                                                 | Unknown unless an explicit usage model exists; it does not establish token units.                                                                                                                                 |
| Droid, Devin, Hermes                 | Unavailable additive tokens: conditional/native usage is retained by Huihua, but current evidence does not establish a report mapping.                                                                                                                                                                                                                                                                                                                                                   | No token fields inferred from other providers.                                                                                                                                                                    |
| Cursor, Antigravity, Grok, Morph, fx | Unavailable: current Huihua adapters do not map native usage.                                                                                                                                                                                                                                                                                                                                                                                                                            | No model-derived token estimates.                                                                                                                                                                                 |

Input and cache field semantics remain provider-specific: Codex/Qwen cached input is included in input, while Claude/Pi-style cache counters are additional.
The total column follows each provider's equation; it does not blindly add every displayed column across providers.

Every native record and repeated usage event remains intact.
The report also retains repeated counters in its sum; repeated response identities (provider-wide for Claude/Codex request facts, source-scoped for other record IDs), fork lineage and replay/branch uncertainty mark affected sums partial and explain the possible overlap.
It does not apply ccusage's replacement/replay heuristics, subtract cumulative snapshots, or reconstruct a selected branch.
A no-replay/no-duplicate input with complete supported counters can produce a complete daily total; uncertainty in other providers does not prevent that provider's total.

A missing model is a null/unknown bucket rather than an invented session-wide last model.
The CLI never creates prices, estimated cost, native cost sums or invoice amounts, and performs no runtime network fetches.
This release focuses on the requested daily token/model report.

## Architecture decision and compatibility

**Owner:** `packages/usage/src/report.ts` owns daily arithmetic, confidence labels, model evidence projection and the versioned CLI report; source reading/normalization remain provider-owned. `docs/architecture.md` records the decision and `tools/policy.ts` enforces public-only imports, absence of report source decoding/I/O, daily/model v2 output and the optional selection capability.

**Alternatives:** retaining observation-only output does not meet the requested daily report.
Global ccusage deduplication would assert unsupported provider semantics.
Adding canonical model/billing fields would change serialized core sessions and require unrelated golden changes.
The report uses public record associations and existing normalized facts instead, without another provider parser.

**Compatibility:** private CLI JSON changes to `huihua-usage/v2`; the unreleased observation-only v1 product is superseded.
Huihua's SPI, `agent-session/v1` and provider parsers are unchanged by this correction.
The subsequent optimizations add the independent `/registry` export, optional `FrameSelection.metadataKeys`, optional `OpenSession.consume`, `OpenSession.consumeUsage`, `OpenSession.consumeUsageFacts` and opt-in `ReadOptions.batchDecode`, without changing existing root exports or default stream/selection semantics.
No dependency is added; TypeScript and pinned `pnpm@12.4.2` remain.
The fallback requests records and `parentSessionId` metadata for attribution and lineage, skipping unselected message normalization; the evidence-free Claude/Codex capability supplies those facts directly.

## Demand-driven metadata and CPU workers

Claude/Codex now receive the existing metadata selector inside their original metadata function, before constructing workspace/title/createdAt/metadata fields.
Shared JSONL ingestion skips unrequested updatedAt patches; native session identity extraction and every parser/tool/unknown/EOF diagnostic remain active.
Full streams, discovery and static agent-session/v1 goldens retain their original fields; other providers keep their compatible mapper.
There is no new public provider API, parser or dependency.

The standalone TypeScript consumer can run different sessions on two/four Node worker threads through the same public provider contracts.
Each worker streams and aggregates locally; it transfers compact token groups, sticky overflow state, confidence/diagnostics and exact identity-to-session associations.
The original builder merges these partitions and detects identities repeated across workers without deleting or replacing native observations.
It never transfers an array of native records/events, merges rounded finalized report totals, or bypasses provider parsing.
Worker failures cancel siblings and await their exits before rejecting; no partial final JSON is emitted.
Ownership, alternatives, private transport compatibility and executable checks are documented in [the architecture decision](architecture.md#demand-driven-metadata-and-cpu-worker-experiment).

### Independent candidate measurements

The [735-run candidate artifact](benchmarks/usage-metadata-workers.json) covers seven inputs, seven modes, one warmup and fifteen rotated/reversed repetitions per case.
The first five inputs are unchanged from the earlier comparison; the added inputs have 100 content-bearing files (20,000 rows, 15,604,670 bytes) and ten larger content files (100,000 rows, 78,066,670 bytes).
The preserved compiled CLI uses its own unchanged core, while metadata-only uses the identical preserved compiled CLI/report with the new public core.
Their CLI hashes are identical, isolating shared metadata demand from consumer/worker implementation changes.
One/two/four-worker candidate modes use the same emitted consumer with equal small ESM wrappers; single-file candidates fall back to serial and cannot establish any threading benefit.
Complete Huihua JSON is byte-identical in every workload/mode, and normalized ccusage daily/model/input/output/cache/total counters match before any timing is accepted.

| Workload                 | Preserved CLI, ms | Metadata-only, ms |
| ------------------------ | ----------------: | ----------------: |
| Usage-only               |             195.6 |             185.4 |
| Content                  |             257.5 |             261.1 |
| Daily/model/cache        |             213.2 |             211.6 |
| Single-day filter        |             159.6 |             153.8 |
| 100 files                |             298.2 |             301.0 |
| 100 content files        |             381.8 |             383.0 |
| Ten larger content files |            1169.9 |            1161.3 |

These are complete-output medians: metadata-only changes range from 5.2% faster to 1.4% slower and do not establish a general speedup.
The eliminated work is concrete, but those allocations were not the dominant cost in every input; full native JSON decoding remains.

| Workload                 | Threads | Complete output, ms | First result, ms | Process peak RSS, KiB |
| ------------------------ | ------: | ------------------: | ---------------: | --------------------: |
| 100 files                |       1 |               295.2 |            291.0 |                65,016 |
| 100 files                |       2 |               313.7 |            304.2 |               113,148 |
| 100 files                |       4 |               281.9 |            271.2 |               145,772 |
| 100 content files        |       1 |               377.9 |            373.1 |                64,904 |
| 100 content files        |       2 |               359.4 |            351.9 |               119,448 |
| 100 content files        |       4 |               339.2 |            328.5 |               165,572 |
| Ten larger content files |       1 |              1162.4 |           1156.4 |                91,896 |
| Ten larger content files |       2 |               902.4 |            891.9 |               177,340 |
| Ten larger content files |       4 |               804.5 |            796.5 |               206,648 |

On the larger input, two/four workers reduce complete-output median by 22.4%/30.8% and beat serial in all fifteen repetitions; RSS increases 1.93/2.25 times.
Four workers reduce content-small-file median 10.2% and beat serial in all fifteen repetitions, but peak RSS increases 2.55 times.
For 100 minimal files, two workers are 6.3% slower; four workers are 4.5% faster in median and win only ten of fifteen repetitions, with 2.24 times RSS.
Unlike Promise-only I/O concurrency, workers execute JSON decoding/mapping/aggregation on separate CPU threads.
Per-isolate startup/heap, structured-clone transport, exact identity tracking and parent merging still cost time and memory; one large file is not split into parallel fragments.
These are observed workload tradeoffs, not an isolated causal percentage breakdown or universal worker recommendation.

The default remains serial; --workers 2/4 is an explicit user choice for multi-file CPU-heavy workloads and is validated against the actual emitted CLI in the final comparison below.
All report fields, provider equations, partial/unavailable scopes, duplicate/cumulative/fork/cache rules and absence of billing estimates remain unchanged.
Measurements use fixture expansions, not real/redacted personal transcripts; no private session store was accessed.
Neither production performance nor performance of the other nineteen provider formats is established by these Claude speed inputs.

To reproduce the candidate comparison after building, supply absolute paths:

```sh
pnpm --filter @huihua/usage bench -- /absolute/path/to/ccusage /absolute/path/to/results.json /absolute/path/to/preserved/src/cli.js --cpu --metadata=/absolute/path/to/metadata-only/src/cli.js
```

The metadata-only consumer preserves the old executable/report and resolves the current public Huihua package; the preserved consumer resolves its own unchanged package.
No baseline parser or binary is maintained in the production package.

### Final user-command validation

The [225-run final artifact](benchmarks/usage-workers-final.json) measures the preserved executable, current serial CLI, actual --workers 2/4 commands and ccusage, with one warmup and fifteen rotated/reversed repetitions on three unchanged inputs.
It includes the final argument parser, compiled worker and shared consumer chunks; all recorded source/build hashes match the delivered code.
The leading -- forwarded by pinned pnpm start is accepted; the focused reproduction failed before the fix and both the compiled regression and actual pnpm help command pass afterward.
The [earlier user-flag validation](benchmarks/usage-workers-cli-candidate.json) remains an archived candidate from before that argument-transport fix, rather than being relabeled as the final build.
No build/test/profile workload ran concurrently with measured children.

| Workload                                   | Variant       | Complete output, ms | First result, ms | Process peak RSS, KiB |
| ------------------------------------------ | ------------- | ------------------: | ---------------: | --------------------: |
| Usage-only, 6,186,670 bytes                | Preserved CLI |               192.0 |            185.6 |                59,868 |
| Usage-only                                 | Serial CLI    |               191.6 |            187.5 |                59,428 |
| Usage-only                                 | --workers 2   |               189.0 |            185.0 |                59,184 |
| Usage-only                                 | --workers 4   |               182.4 |            178.3 |                59,572 |
| Usage-only                                 | ccusage       |                56.3 |             55.7 |                37,676 |
| 100 content files, 15,604,670 bytes        | Preserved CLI |               390.2 |            385.0 |                62,080 |
| 100 content files                          | Serial CLI    |               383.7 |            379.3 |                64,024 |
| 100 content files                          | --workers 2   |               355.5 |            348.1 |               120,044 |
| 100 content files                          | --workers 4   |               329.2 |            317.1 |               166,688 |
| 100 content files                          | ccusage       |                49.4 |             48.9 |                50,076 |
| Ten larger content files, 78,066,670 bytes | Preserved CLI |              1170.8 |           1164.7 |                92,588 |
| Ten larger content files                   | Serial CLI    |              1139.8 |           1133.4 |                92,724 |
| Ten larger content files                   | --workers 2   |               850.2 |            836.6 |               168,164 |
| Ten larger content files                   | --workers 4   |               688.3 |            677.0 |               209,248 |
| Ten larger content files                   | ccusage       |               278.4 |            277.8 |               140,208 |

These are per-metric medians of full-report measurements, not isolated parser throughput or guaranteed production savings.
On the larger multi-file input two/four workers reduce complete-output time 25.4%/39.6% versus serial, faster in every repetition; process peak RSS increases 1.81/2.26 times.
Four-worker first-output latency falls 40.3%; there is still no provisional report output before all sources complete.
On 100 content files four workers save 14.2% in median and win fourteen of fifteen repetitions, with 2.60 times process peak RSS.
Single-file worker flags do not launch threads; their small timing differences are not evidence of CPU parallelism or a reason to change serial defaults.
Source/argument versions and runtime variability make cross-round percentages non-additive; use each round's paired same-input controls.

All complete Huihua JSON hashes match across variants; ccusage daily/model/token counters match after normalization.
Huihua still emits confidence, provenance, diagnostics and per-session totals, while ccusage's product shape and replay/deduplication rules differ.
Final four-worker time is still 2.47 times ccusage on the larger input and 6.66 times on 100 content files; matching this narrower native implementation has not been achieved.
The verified architectural work differences remain full native JSON decoding versus narrower deserialization, additional validation/identity/report work, and per-isolate startup/clone/merge costs.
No ccusage CPU phase profile establishes their individual shares, so the remaining gap is not assigned entirely to Rust versus TypeScript.

Environment remains Node v24.19.0, Huihua 0.2.0, Usage 0.1.0, pnpm 12.4.2 and official ccusage 20.0.26 on Debian 13/Linux 6.18.44, x64 AMD EPYC 9V74 with four available CPUs.
Each fresh child is timed spawn-to-close and to first report stdout byte; Linux process VmHWM includes all worker threads and is sampled every 2 ms (a final peak can be missed).
Inputs, per-file content hashes, versions, binary/source/build hashes, raw repetitions and normalized matching reports are recorded in both artifacts.
The inputs are synthetic fixture expansions with unique response identities; replay/forks/cumulative/unsafe/undated cases are covered by regressions but not by these timing samples.
Authorized real/redacted-session performance and other-provider speed comparisons remain unmeasured.

Run the user command after building:

```sh
pnpm --filter @huihua/usage start -- --provider claude --workers 4 --json
```

Reproduce final timings with absolute paths; omit the preserved executable if no independent baseline installation is available:

```sh
pnpm --filter @huihua/usage bench -- /absolute/path/to/ccusage /absolute/path/to/results.json /absolute/path/to/preserved/src/cli.js --published
```

## Previous four optimization experiments

All four candidates were implemented inside the existing acquisition/mapping contracts, without another parser or dependency.
Compact facts bypass canonical event/frame construction; a synchronous consumer-owned timestamp predicate can reject usage before native context allocation and reuse the accepted calendar date.
Batch UTF-8 decoding uses at most 256 KiB of complete lines in the already acquired chunk, with exact original row framing/limits and per-line fallback.
The private runner tests one/two/four incremental files while serializing buffered readers and settling/closing every started source on failure.
Owners, alternatives and compatibility are in [the architecture decision](architecture.md#four-usage-optimization-experiments), with executable guards and fixture/CLI equivalence tests.

The [560-run candidate artifact](benchmarks/usage-four-experiments.json) measures five 20,000-row fixture expansions, sixteen modes, one warmup per case and seven rotated/reversed repetitions.
The first three inputs match the earlier comparisons; two additional inputs cover a single-day query over 31 days and 100 files with 200 rows each.
Every Huihua full JSON output is byte-identical within a workload; ccusage daily/model/input/output/cache/total fields match after normalization.
The artifact records source/binary/build/input hashes, byte counts, per-file manifest, runtime/system, first output and sampled Linux VmHWM, including every repetition.
Inputs are synthetic fixture expansions with unique response identities, not real or redacted production sessions; no personal stores were accessed.

| Workload          | Control | Compact facts | Batch decode | Facts + date predicate | Two files | Four files | Combined / serial | Combined / four |
| ----------------- | ------: | ------------: | -----------: | ---------------------: | --------: | ---------: | ----------------: | --------------: |
| Usage-only        |   206.8 |         211.2 |        204.8 |                  203.1 |     201.1 |      197.5 |             208.0 |           209.1 |
| Content           |   265.6 |         286.5 |        280.1 |                  272.8 |     265.5 |      280.9 |             281.5 |           282.9 |
| Daily/model/cache |   224.3 |         232.9 |        239.6 |                  233.6 |     224.6 |      227.2 |             239.9 |           248.0 |
| One day out of 31 |   188.9 |         198.6 |        213.5 |                  175.4 |     209.7 |      201.6 |             181.7 |           177.1 |
| 100 files         |   351.5 |         363.4 |        358.0 |                  354.6 |     341.2 |      352.9 |             352.1 |           340.6 |

Numbers are median complete-output milliseconds using the same built runner and one small ESM wrapper in every candidate/control.
Compare date pushdown to compact facts (198.6 to 175.4 ms on the narrow case); compared to control it saves 7.2% in that case.
Compact facts alone do not reliably accelerate a complete report, and batch decoding regresses four of the five medians while increasing sampled memory in those cases.
Concurrent reading does not parallelize JavaScript parsing/aggregation; the 100-file medians fluctuate, and combined four-file sampled peak RSS rises from 64,904 to 77,960 KiB versus control.
Single-file concurrency differences are measurement noise, not an effect of reading files in parallel.
The selected default is therefore compact facts plus date filtering for explicit single-day queries only, serial reading, and original per-line decoding.
Other queries retain the earlier evidence-free consumption, and other providers retain their compatible public-contract fallback.
All experimental switches are private benchmark controls, not CLI flags; the optional core capabilities remain tested opt-ins.

These explanations describe eliminated or added work, not an isolated causal decomposition of timing.
The date predicate avoids mapping context, usage envelopes and report-field projection for rejected rows, but still decodes every native row and runs validation/identity/tool/EOF diagnostics.
Batch decoding saves TextDecoder calls but adds string scanning/slicing and a chunk-sized decoded string; the larger allocations and observed RSS increase can outweigh the saved calls.
Facts still need native usage metadata and a delivery object, and splitting the hot path changes runtime optimization; removal of two wrappers alone did not establish a gain.
I/O concurrency can overlap reads, but this warm fixture workload still parses and aggregates on one JavaScript thread; no cold-storage or real-session claim is made.
No ccusage CPU phase profile was collected, so differences from its narrower Rust deserialization, parallel file processing and smaller report are work differences, not measured percentages of the gap or proof of a language-speed factor.
The pinned [Claude daily implementation](https://github.com/ccusage/ccusage/blob/b8bfa6aa2f179de118c2ef3bf066b1e4372878d2/rust/adapters/claude/src/daily.rs) shows `DailyUsageMessage` selecting usage/model/id, a byte usage marker, whole-file buffers and `thread::scope` across size-balanced file groups.
Our tested Promise pool overlaps I/O without parallelizing parsing; it is not an equivalent implementation of those threads.

### Final default validation

The [450-run final artifact](benchmarks/usage-four-final.json) repeats five identical inputs with six modes, one warmup per mode/input and fifteen measured repetitions.
It measures the actual compiled CLI, preserved compiled CLI/core, three controlled fact/filter variants and ccusage 20.0.26; all full-report and comparable-counter gates pass again.
Recorded source/build hashes match the final maintained code; only CLI default selection and benchmark phase controls changed after the candidate round, while the shared parser remained the same.
Node v24.19.0 and pinned pnpm 12.4.2 run on Debian 13/Linux 6.18.44, x64 AMD EPYC 9V74 with four available CPUs.
Full output is spawn-to-close, first result is the first report stdout byte, and child kernel VmHWM is sampled every 2 ms (a final peak can be missed).
Generation, building, other tests and profiling are outside timed runs; no simultaneous test/build workload was run during measurement.

| Workload                           | Variant       | Complete output, ms | First result, ms | Peak RSS, KiB |
| ---------------------------------- | ------------- | ------------------: | ---------------: | ------------: |
| Usage-only, 6,186,670 bytes        | Preserved CLI |               205.4 |            200.8 |        58,760 |
| Usage-only                         | Final CLI     |               213.5 |            209.3 |        60,336 |
| Usage-only                         | ccusage       |                62.4 |             61.9 |        37,672 |
| Content, 15,386,670 bytes          | Preserved CLI |               276.2 |            271.8 |        62,328 |
| Content                            | Final CLI     |               281.9 |            277.5 |        63,132 |
| Content                            | ccusage       |               146.6 |            146.0 |        58,172 |
| Daily/model/cache, 6,286,670 bytes | Preserved CLI |               226.7 |            222.9 |        61,216 |
| Daily/model/cache                  | Final CLI     |               234.6 |            230.6 |        62,424 |
| Daily/model/cache                  | ccusage       |                59.0 |             58.6 |        37,680 |
| One day out of 31, 6,286,670 bytes | Preserved CLI |               184.2 |            180.2 |        51,772 |
| One day out of 31                  | Final CLI     |               161.4 |            157.1 |        51,992 |
| One day out of 31                  | ccusage       |                60.4 |             60.2 |        37,684 |
| 100 files, 6,404,670 bytes         | Preserved CLI |               306.0 |            301.4 |        67,852 |
| 100 files                          | Final CLI     |               318.5 |            311.8 |        65,764 |
| 100 files                          | ccusage       |                30.0 |             29.6 |        37,752 |

These are separate metric medians, not guaranteed speedups or exact causal phase costs.
On the narrow single-day input the actual CLI reduces complete-output time by 12.4% and first-output latency by 12.8%, and beats the preserved CLI in all fifteen repetitions; peak RSS is essentially unchanged.
Same-wrapper pushdown/control medians are 165.7/186.7 ms (11.3% less time), and pushdown/facts are 165.7/191.9 ms (13.7% less time); each is faster in fourteen of fifteen repetitions.
The other actual CLI medians are 2.1–4.1% slower than the preserved CLI and beat it in only three to six of fifteen repetitions; their ranges overlap and this round does not isolate shared dispatch/runtime effects.
That is a measured tradeoff, not a claim that unchanged query selection guarantees unchanged performance or that all differences are noise.
The selected default targets single-day queries; compact-fact construction, batch decoding and parallel file counts are not claimed as general speedups.
Final CLI time is still 1.9–4.0 times ccusage on the single-file inputs and 10.6 times on the hundred-file input.
The multi-file gap also includes separate file discovery/opens and Huihua's 100 per-session result sections (409,736 output bytes versus ccusage's 2,356); no profiling partition of this gap was measured.
The artifact includes both complete-output hashes and matching normalized daily/model totals, not just startup or parser throughput.
Replay/forks, repeated identities, cumulative counters, missing/invalid times and native costs are not present in the speed samples; regression fixtures cover those rules, but full cross-tool semantic equivalence is not established for those cases.
No authorized real or redacted production sample was available, so production performance remains unmeasured.

After building, reproduce the final phase with absolute output/binary paths (pnpm filter runs inside the package directory):

```sh
pnpm --filter @huihua/usage bench -- /absolute/path/to/ccusage /absolute/path/to/results.json /absolute/path/to/preserved/src/cli.js --final
```

Omit `--final` to run every four-experiment mode with seven repetitions.
The preserved executable must resolve its own unchanged compiled Huihua package and production dependencies rather than the current workspace build.

## Previous evidence-free usage comparison

`OpenSession.consumeUsage` extends the existing ingestion pipeline, with provider-owned same-record context and no RawRecord construction or delivery.
Claude and Codex support it; the other 18 providers use the compatible fallback, including native records when required for model/branch/embedded-message facts.
The provider token support matrix and all report fields/rules remain unchanged.
All malformed-input, identity, unknown-format and tool diagnostics still run, as do strict UTF-8/JSON decoding and limits.
Complete evidence is constructed only when requested by stream/snapshot/record-bearing selection.
Owner, alternatives and compatibility are in [the evidence-free usage decision](architecture.md#evidence-free-usage-consumption); executable policy and installed-package checks enforce the public capability.

This comparison preserves the immediately previous **compiled** CLI and its own compiled core, rather than comparing against the earlier runtime-TypeScript CLI.
Both actual CLIs run emitted JavaScript, so this round does not include the earlier compilation/startup improvement.
Eight modes (previous CLI, full/selected/callback/evidence-free workers, iterator CLI, actual CLI and ccusage), one warmup and seven rotated/reversed repetitions on each of the same three inputs produce 168 measured runs.
Complete Huihua JSON is byte-identical in every mode/input; normalized ccusage daily/model/input/output/cache totals match.
Versions, environment, source/binary/build/input hashes, first output, sampled VmHWM, raw repetitions and comparable reports are recorded in [the 168-run artifact](benchmarks/usage-context-final.json).

| Input                                            | Variant               | Complete output, ms | First result, ms | Peak RSS, KiB |
| ------------------------------------------------ | --------------------- | ------------------: | ---------------: | ------------: |
| Usage-only, 6,186,670 bytes                      | Previous compiled CLI |               206.1 |            197.5 |        64,868 |
| Usage-only                                       | Evidence-free CLI     |               193.3 |            189.3 |        59,040 |
| Usage-only                                       | ccusage               |                58.1 |             57.7 |        37,664 |
| Content, 15,386,670 bytes                        | Previous compiled CLI |               273.2 |            267.9 |        64,680 |
| Content                                          | Evidence-free CLI     |               272.1 |            267.9 |        62,516 |
| Content                                          | ccusage               |               143.5 |            143.0 |        58,156 |
| Three days / two models / cache, 6,286,670 bytes | Previous compiled CLI |               234.6 |            230.2 |        62,876 |
| Three days / two models / cache                  | Evidence-free CLI     |               227.2 |            222.5 |        61,064 |
| Three days / two models / cache                  | ccusage               |                57.2 |             56.8 |        37,688 |

These are medians, not guaranteed speedups: complete-output reductions are 6.2%, 0.4% and 3.2%; the content result is effectively unchanged at this sample size.
Sampled peak RSS medians fall by 9.0%, 3.3% and 2.9%, but GC timing and the 2 ms sampler limit causal claims.
The same-worker callback/evidence-free times are 270.4/272.5, 357.5/330.3 and 302.2/306.3 ms: evidence removal is not a consistent throughput gain in every workload/runtime shape.
Workers still import the full registry and runtime TypeScript, so their absolute times do not describe the compiled CLI.
Do not multiply these gains by results from earlier rounds.

The current CLI still takes about 1.9–4.0 times ccusage's time on these samples.
Removing complete record creation removes evidence envelopes, text/byte associations and consumer record handling; it does **not** remove row decoding, identity/tool checks, usage event envelopes or daily aggregation.
The earlier compiled profile attributed 33 ms to native JSON decoding and 12 ms to record construction, with additional line/UTF-8, GC and aggregation work; eliminating records alone cannot remove those other phases.
ccusage's pinned Claude daily adapter filters rows for usage and deserializes a narrower structure, then produces a different report shape and applies different replay rules.
Huihua retains broader validation and confidence/session/provenance output; no ccusage CPU phase profile was collected, so these are evidenced work differences, not a measured partition of the entire gap or a language-speed factor.

### Selective JSON decoding investigation

The pure-JS MIT `@streamparser/json@0.0.26` library has no runtime dependencies and supports requested paths with `keepStack: false`.
It was evaluated in scratch space rather than installed into the production package.
For 20,000 fixture-derived rows, a nine-path selection retained only envelope identity/time and message id/model/usage.
With one warmup and seven alternating repetitions, native JSON.parse median decode times were 33.6 ms (usage-only) and 90.8 ms (content); the selective library took 293.6 and 702.8 ms.
The library still tokenizes/decodes skipped strings, and adds JavaScript tokenizer/path/callback work; keeping fewer objects does not avoid those costs.
`stream-json@3.7.0` was also inspected: it is pure JS/BSD-3-Clause with stream-chain as a transitive dependency, but its tokenizer still scans/decodes strings before filtering.
No production codec was replaced and no dependency added.

The [decoder probe artifact](benchmarks/usage-selective-decoder-probe.json) contains raw samples, exact exploratory script, library tarball URL/hash, version and limitations.
This is a decode-only diagnostic probe, **not** a full-output CLI comparison or proof of general provider/duplicate-key/tool compatibility.
It rejects this candidate as a speed optimization; it does not establish that all selective decoders are slower or that selective decoding is impossible.
No custom JSON lexer, unsafe substring filter or second provider parser was introduced.
Full native JSON decoding therefore remains a concrete limitation of this implementation; the new capability separates required usage facts from evidence so a future suitable shared codec need not change CLI aggregation.

All benchmark inputs are synthetic fixture expansions with unique response identities, not authorized real/redacted production transcripts.
No private session store is read.
Replay, forks, cumulative counters and unsupported/undated usage are covered by fixtures but are not represented in the speed samples; ccusage's replacement/deduplication differs on these cases.
There is no production-wide or Huihua-faster claim.

## Previous executable and pipeline comparison

The second optimization pass keeps the provider parsers and all report fields unchanged:

- The existing file framer returns its generator directly; ingestion reuses each line as evidence rather than allocating another text/bytes object.
- Optional public `OpenSession.consume(selection, consumer)` delivers the same selected frames after each native record is mapped.
  Synchronous callbacks avoid per-frame async iterator round trips; promised callbacks retain backpressure.
  Cancellation, consumer errors, suffix validation, zstd checksums and EOF tool diagnostics remain enforced.
- Plain JSONL no longer initializes the existing binary/hash module.
  Compressed sources load it before opening the stream and retain the same decoder/checksum checks.
- The private CLI is built by the existing pinned tsdown tool and runs its JavaScript executable.
  Maintained sources stay TypeScript, and every Huihua public import remains external.
  This removes runtime TypeScript stripping, not native evidence or diagnostics.

Owners, alternatives and compatibility are recorded in the architecture's [JSONL forwarding](architecture.md#jsonl-forwarding-and-evidence-allocation), [callback consumption](architecture.md#callback-frame-consumption) and [compiled executable](architecture.md#compiled-usage-executable) decisions.
A local decoder-only probe found Buffer UTF-8 validation plus decoding slightly slower than fatal TextDecoder (usage-only 4.05 versus 3.35 ms; content 4.25 versus 3.67 ms for 20,000 warmed line decodes).
It was rejected; this probe is not an end-to-end or cross-tool speed result.

The final comparison uses Huihua 0.2.0 and Usage 0.1.0 checkout sources identified by hashes, Node v24.19.0, pnpm 12.4.2 and official ccusage 20.0.26 on the same Linux/Debian/AMD environment described below.
The baseline is the previous source CLI/build from before this pass, with its consumer package.json and its own installed/built Huihua preserved.
The current actual executable is `packages/usage/dist/cli.js`; prebuilding, generation and profiling are outside timed runs, as with the supplied prebuilt ccusage binary.
The six current modes plus previous CLI each receive identical input paths; one warmup and seven rotated/reversed sequential measurements per mode/input produce 147 measured runs.
Every complete Huihua JSON is byte-identical across full, selected, callback, iterator CLI, compiled CLI and baseline; ccusage's daily/model counters match after presentation-order normalization.
Output still includes Huihua confidence, diagnostics, provenance and per-session totals, so product JSON shape differs from ccusage.

| Input                                            | Variant              | Complete output, ms | First result, ms | Peak RSS, KiB |
| ------------------------------------------------ | -------------------- | ------------------: | ---------------: | ------------: |
| Usage-only, 6,186,670 bytes                      | Previous CLI         |               271.5 |            258.8 |        84,152 |
| Usage-only                                       | Current compiled CLI |               191.4 |            182.5 |        64,848 |
| Usage-only                                       | ccusage              |                57.1 |             56.2 |        37,672 |
| Content, 15,386,670 bytes                        | Previous CLI         |               344.9 |            334.4 |        83,792 |
| Content                                          | Current compiled CLI |               275.3 |            270.8 |        65,236 |
| Content                                          | ccusage              |               140.5 |            140.0 |        58,148 |
| Three days / two models / cache, 6,286,670 bytes | Previous CLI         |               283.4 |            277.2 |        84,928 |
| Three days / two models / cache                  | Current compiled CLI |               217.5 |            212.9 |        63,516 |
| Three days / two models / cache                  | ccusage              |                58.4 |             58.0 |        37,676 |

These are medians: this pass reduces complete-output time by 29.5%, 20.2% and 23.3%, and sampled peak RSS by 22.9%, 22.1% and 25.2%.
The current CLI still takes about 2.0–3.7 times ccusage's time on these controlled inputs.
Comparing the same compiled runner/build with callback disabled gives iterator CLI times 212.7, 298.9 and 238.4 ms, versus callback CLI 191.4, 275.3 and 217.5 ms (10.0%, 7.9%, 8.8% less time).
The iterator CLI uses one extra small ESM entry module; its exact wrapper and this startup difference are recorded.
The same-worker selected/callback comparison is 287.2/275.4, 367.9/344.8 and 324.0/303.9 ms.
That worker retains runtime TypeScript stripping and imports the full registry, so it is measured separately from the actual executable.
The callback direction is supported in both comparisons, but seven repetitions and timing variation do not establish a universal gain or a causal partition of every saved millisecond.

[The final 147-run artifact](benchmarks/usage-executable-final.json) includes input/source/emitted executable/baseline/binary hashes, versions, raw times, first output, sampled VmHWM and matching reports.
Intermediate [reader](benchmarks/usage-reader.json), [callback](benchmarks/usage-callback.json), [delivery isolation](benchmarks/usage-delivery.json), [source executable isolation](benchmarks/usage-consume-final.json) and [lazy-binary pipeline](benchmarks/usage-pipeline-final.json) runs remain archived; their source hashes distinguish the experiments.
Across-round medians must not be used to attribute an individual optimization or multiply speedups.

A separate final compiled-CLI CPU profile lasts about 254 ms, with sampled self time in line/UTF-8 work (51.2 ms), full native JSON parsing (33.1 ms), GC (23.8 ms), report `add` (20.6 ms), ingestion (16.4 ms) and public record construction (11.9 ms).
Node's Amaro runtime TypeScript stripping is absent from this executable; it accounted for the earlier `__require` sample, not xxhash initialization.
ccusage's pinned Claude daily implementation parses a narrower structure, while Huihua still decodes complete native JSON and preserves record associations, identity/tool/unsupported diagnostics and report confidence.
These source differences and the profile identify remaining work, without measuring ccusage's CPU phases or assigning the whole gap to Rust versus TypeScript.

To reproduce after building:

```sh
pnpm build
pnpm --filter @huihua/usage bench -- /absolute/path/to/ccusage /absolute/path/to/results.json
```

Add a preserved `/absolute/path/to/baseline/src/cli.ts` as the final argument for before/after measurements.
Preserve its consumer package.json, CLI/report/options and independently built/installed Huihua before editing; its build must not resolve to the current core.
The ordinary `pnpm check` does not run benchmarks.

All samples are fixture-derived synthetic inputs with unique response identities, not a real/redacted production corpus.
They do not exercise replay/forks/cumulative/price complexities.
Huihua retains repeated counters with partial diagnostics, whereas ccusage may replace/deduplicate replay entries; unsupported/undated/cumulative scopes also differ.
The 20-provider evidence matrix and per-provider arithmetic above remain unchanged.
No production-wide or Huihua-faster claim follows, and static v1 goldens are untouched.

## Previous startup/allocation optimization comparison

Three measured costs are removed without changing the daily/model report:

- Selected-provider startup uses the additive public `huihua/registry` entrypoint and only selected public provider modules.
  Unfiltered discovery uses the complete registry.
- UTC avoids the unused Intl constructor, caches its current calendar day and current model group, and removes unused per-record/per-usage allocations.
  Cline's same-record embedded model lookup remains provider-specific; DST zones still use Intl.
- The existing selective parser delivers only `parentSessionId` metadata patches to Usage.
  In the 20,000-row content diagnostic this removes 40,000 unrelated metadata frames; identity extraction/checks, native JSON, evidence records and tool/unsupported diagnostics still run.

Owners, alternatives and additive compatibility are specified in [the architecture decision](architecture.md#usage-startup-and-allocation-decision).
There is no second parser, billable deduplication, new dependency, native core, index or network runtime.

The final harness runs the preserved pre-optimization CLI, current full/selected workers, current CLI and ccusage in the same rotated/reversed sequence against exactly the same temporary input paths.
There is one warmup and seven measurements per variant/input, totaling 105 measured runs.
Every complete Huihua JSON is byte-identical within an input, including the previous CLI; daily/model counters also match ccusage after the documented presentation normalization.
Environment, inputs, output semantics and sampled VmHWM method are those of the baseline below, with updated source and preserved baseline package/built-file hashes.

| Input                                            | Variant      | Complete output, ms | First result, ms | Peak RSS, KiB |
| ------------------------------------------------ | ------------ | ------------------: | ---------------: | ------------: |
| Usage-only, 6,186,670 bytes                      | Previous CLI |               380.4 |            366.3 |        99,220 |
| Usage-only                                       | Current CLI  |               310.0 |            296.8 |        83,972 |
| Usage-only                                       | ccusage      |                61.4 |             60.9 |        37,684 |
| Content, 15,386,670 bytes                        | Previous CLI |               461.4 |            452.7 |        95,360 |
| Content                                          | Current CLI  |               370.3 |            361.8 |        83,092 |
| Content                                          | ccusage      |               147.7 |            147.2 |        58,172 |
| Three days / two models / cache, 6,286,670 bytes | Previous CLI |               351.0 |            343.7 |        99,280 |
| Three days / two models / cache                  | Current CLI  |               296.6 |            290.4 |        84,912 |
| Three days / two models / cache                  | ccusage      |                61.8 |             61.4 |        37,680 |

These are medians.
The combined optimization reduces complete-output time by 18.5%, 19.7% and 15.5%, and sampled peak RSS by 15.4%, 12.9% and 14.5% respectively.
Current CLI time remains about 2.5–5.0 times ccusage's on these inputs.
The same-worker full/selected content comparison is 719.3 versus 400.3 ms; on usage-only it is 333.7 versus 314.8 ms, and on mixed daily/models 343.6 versus 339.9 ms.
There is no substantial consistent selection benefit on inputs without message content.
The [105-run final artifact](benchmarks/usage-optimized.json) records all timings and input/source/binary hashes.
The [intermediate startup/allocation experiment](benchmarks/usage-startup.json) also retains 105 runs, but cross-round timing differences do not isolate the incremental metadata-selector effect; only within-round comparisons are reported as speedups.

A separate stage worker importing the complete registry constructs the UTC builder in 0.31 ms and delivers 20,000 record and 20,000 usage frames with no metadata frames on the content input.
Its consumption includes 51.4 ms inside aggregation; stage instrumentation is excluded from benchmark measurements.
A separate actual-CLI CPU profile lasts about 353 ms, with sampled self time in line/UTF-8 work (55.4 ms), full native JSON decoding (35.5 ms), GC (26.6 ms), aggregation `add` (17.5 ms), `emit` (15.7 ms), ingestion iteration (13.0 ms) and async microtasks (13.1 ms).
These are single diagnostic profiles, not controlled causal measurements of ccusage or of each individual optimization.
The remaining gap has concrete narrower-versus-complete parsing and frame/diagnostic/identity work behind it; declaring a language-speed factor would not be supported.
Discovery and final formatting were small in the baseline profile, so eliminating report columns or bypassing discovery is not an evidenced next optimization.
Further core work should profile the existing framer/ingestion and preserve strict UTF-8, limits, full evidence, identity validation, cancellation and EOF diagnostics; a CLI-owned narrow parser is outside the architecture boundary.

To reproduce current versus ccusage after building, supply an installed native binary:

```sh
pnpm --filter @huihua/usage bench -- /absolute/path/to/ccusage /absolute/path/to/results.json
```

For a before/after experiment, preserve the consumer package.json, `src/{cli,options,report}.ts` and an independently installed `node_modules/huihua` under a baseline directory before changing/building the code, then pass `/absolute/path/to/baseline/src/cli.ts` as the final argument.
The baseline needs the same production dependencies; its own built package must not resolve to the current workspace build.
The harness hashes its package and every built JS/declaration file, and rejects changed complete reports.
No binary or baseline parser copy is maintained in the production repository.

Inputs remain fixture-derived synthetic workloads rather than authorized real/redacted production sessions.
Their lack of replay/forks/cumulative scopes makes them comparable, but does not establish production performance or complete cross-tool semantic equivalence.
All 20 provider evidence/arithmetic entries above remain the support boundary; no new provider usage capability is inferred by this optimization.

## Daily/model v2 baseline performance comparison

Before the startup/allocation/metadata optimizations on 2026-10-06, the maintained TypeScript harness ran all three fixed fixture-derived inputs through public-contract full/selected workers, the actual CLI, and the official ccusage 20.0.26 Linux x64 binary.
The daily/model input has three dates, two models and nonzero input/output/cache counters; the other inputs isolate usage and message content.
There are 20,000 unique response rows in each input.
No personal session directories are read.
HOME, XDG and Claude roots are isolated inside the generated temporary fixture tree.

The environment is Node v24.19.0, pinned pnpm 12.4.2, Debian 13 x64, Linux 6.18.44 and AMD EPYC 9V74.
The raw metadata's `onlineCpus` value records Node `availableParallelism()` (4 available CPUs), not the host's total hardware cores.
After one warmup per variant/input, seven fresh-process measurements rotate/reverse variant order and run sequentially.
Complete output is timed from spawn to process close; first result is the first stdout byte.
Child kernel VmHWM is sampled every 2 ms and may miss a final peak.
Input generation and profiling are excluded from timings.

Before retaining any timing, the harness compares every daily and grand input/output/cache/total value and every model's counters.
Model names/list order are normalized by name: ccusage's model-list presentation order differs on the mixed workload.
All quantity/date/model-set semantics match.
All Huihua full/selected/actual-CLI complete JSON outputs are byte-identical within each input and repetition.
Huihua additionally emits confidence, diagnostics, provenance and per-session totals, so raw JSON bytes differ from ccusage.
This is a common daily/model token calculation comparison with that additional serialization explicitly included, not a byte-identical product-output claim.

| Input                           |      Bytes | Huihua CLI full output, ms | First result, ms | Peak RSS, KiB | ccusage full output, ms | First result, ms | Peak RSS, KiB |
| ------------------------------- | ---------: | -------------------------: | ---------------: | ------------: | ----------------------: | ---------------: | ------------: |
| Usage-only                      |  6,186,670 |                      352.8 |            346.0 |        98,324 |                    61.1 |             60.7 |        37,684 |
| Message content                 | 15,386,670 |                      403.7 |            397.4 |        94,636 |                   141.6 |            141.2 |        58,164 |
| Three days / two models / cache |  6,286,670 |                      333.2 |            326.6 |        97,900 |                    58.8 |             58.4 |        37,664 |

These are medians of seven runs.
In these controlled samples ccusage completes the matching daily/model calculation about 2.9–5.8 times sooner.
The same-worker full/selected comparison is 696 versus 406 ms on message content (about 42% less time), with identical complete output.
Inputs without message content show only small full/selected differences: 348 versus 346 ms for usage-only and 344 versus 329 ms for the mixed daily/model input.
They do not establish a substantial or consistent selection benefit; there is no unneeded message content conversion to remove.
The actual CLI has a slightly different startup import set from the benchmark workers and is measured separately.

The v2 report no longer traverses and collects native scalar observations.
A separate selected-content diagnostic run spends 73.4 ms importing, 3.9 ms discovering sources, 12.8 ms constructing the report, 329.8 ms consuming records (including 76.3 ms inside aggregation), 0.6 ms finishing and 0.03 ms serializing.
It delivers 20,000 record, 20,000 usage and 40,000 metadata frames.
A separate actual-CLI CPU profile of about 394 ms attributes sampled self time to line/UTF-8 work (45.7 ms), native JSON parsing (42.9 ms), report `add` (32.1 ms), ingestion iteration (27.3 ms) and garbage collection (16.3 ms).
This does not measure ccusage's CPU phases or prove an exact percentage attribution of the cross-tool gap.

The pinned ccusage Claude daily source cited in provider research reads a file buffer, tests a byte usage marker and deserializes a narrow `DailyUsageLine`; Huihua's existing reader decodes the complete native JSON record, creates public evidence/usage/metadata envelopes, preserves tool/identity/unsupported diagnostics and runs the report projection.
Node imports/initialization are also visible in the diagnostic run.
This source difference and the observed Huihua phases explain concrete extra work in the current path; Rust versus TypeScript alone is not a measured causal explanation.
Source discovery and final serialization are small here, so bypassing discovery or removing report columns is not supported as a meaningful remedy.
Skipping already-unselected message conversion is useful on content-rich input; replacing the native JSON reader with an independent usage parser would violate the shared provider contract.

[All 84 measured runs, hashes, runtime metadata and normalized matching reports](benchmarks/usage-daily.json) are committed.
Reproduce after `pnpm build` with an explicitly supplied native binary; the harness does not download it or fetch prices:

```sh
pnpm --filter @huihua/usage bench -- /absolute/path/to/ccusage /absolute/path/to/results.json
```

The maintained generator/worker is `packages/usage/tools/bench.ts`.
Inputs are synthetic fixture-derived examples, not a real anonymized production corpus.
They contain no duplicates, replay, fork, cumulative snapshots or cost complexities; equality on them does not establish full ccusage semantic compatibility or production performance.
Huihua retains repeated counters with partial labels, while ccusage can replace/deduplicate replay entries; cumulative/undated and unsupported schemas also differ.
No Huihua-faster claim follows from these measurements.
Static v1 compatibility goldens are untouched.

## Historical observation-only v1 performance comparison

The report consumes streaming frames and retains per-session counters, bounded scalar examples and distinct diagnostic messages rather than event or record arrays; provider-documented buffered readers remain buffered.
A measured comparison used the officially published native Linux binary for `ccusage 20.0.26` (`@ccusage/ccusage-linux-x64@20.0.26`).
The GitHub release has no attached binary assets; the binary was fetched from the package's official npm registry tarball and its published SHA-512 integrity (`46wa7ImMzejMUuo5pSI2uYml7jgE58TID2/QQS9YJO3BwI6woyti6cy3xtZk+TyG1HiyzeH8P+3r8hSVDaAvsg==`) was verified before execution.

| Measurement setup         | Value                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input and provider        | Same temporary Claude JSONL file and path, both tools; 20,000 unique assistant usage rows, 6,186,670 bytes                                                                  |
| Fixture source            | Deterministic synthetic rows based on `fixtures/claude/usage-only.jsonl`; no personal sessions or external data                                                             |
| Shared filters            | Claude only; `2026-01-01` inclusive; UTC; JSON; no cost calculation                                                                                                         |
| Comparable token evidence | Each source row has `output_tokens=4`; Huihua reports 20,000 native observations and bounded examples, while ccusage reports `outputTokens=80,000` and `totalTokens=80,000` |
| Huihua output scope       | Provider and session report, raw field paths, observation counts, examples, diagnostics and semantic notes (5,783 output bytes)                                             |
| ccusage output scope      | Daily aggregation with built-in model breakdown fields (629 output bytes)                                                                                                   |
| Runtime / OS              | Huihua on Node.js v24.19.0; ccusage native Rust ELF binary; Debian GNU/Linux 13 x86_64, Linux 6.18.44, AMD EPYC 9V74, 5 online CPUs                                         |
| Repetitions               | One warmup each, then 7 measured runs per tool, interleaved                                                                                                                 |

| Median across 7 runs                    |     Huihua | ccusage 20.0.26 |
| --------------------------------------- | ---------: | --------------: |
| Complete output time                    |   1,741 ms |         56.2 ms |
| First stdout byte / first report result |   1,732 ms |         55.7 ms |
| Peak RSS                                | 96,316 KiB |      37,660 KiB |

Both commands emit a single complete JSON report only after reading the file, so first stdout byte is the first user-visible result and is close to complete-output time.
The shell-free harness starts the child process, captures first stdout, times process close, and samples each child's kernel `VmHWM` from `/proc/<pid>/status` every 2 ms.
It warms each tool once and alternates tool order for seven samples.
Raw observations, the input generator and the runner were kept temporarily outside the repository and are not shipped.

The common source fact maps cleanly to the same output-token quantity because the generated input has exactly one distinct usage observation per row and every such observation is four tokens.
Huihua intentionally does not sum those observations: repeated IDs, replay and provider-specific usage semantics remain visible, and it does not promise that every provider's observations are additive.
Therefore these numbers document an observed end-to-end difference for this selected Claude fixture, not a general claim that the two products perform identical report work.
Report contents differ materially in detail and size, and other providers cannot be compared until their duplicate, snapshot, branch and cost semantics are aligned.

In this initial run ccusage finished about 31 times sooner and used about 2.6 times less peak RSS.
The follow-up profiling below identified a repeated formatter initialization in the reporter as the dominant avoidable cost.
The initial gap should not be attributed chiefly to evidence preservation, Node.js or native Rust without that profiling evidence.
Remaining cost and output-scope differences still prevent a general same-report speed claim between Huihua and ccusage.

## Historical observation-only v1 profiling and optimization

These measurements describe the superseded observation-only report, not the daily/model v2 report.

On 2026-10-06 a CPU profile of the original date-filtered Usage CLI attributed about 1,105 ms of an approximately 1,778 ms profile to `calendarDay`.
It constructed a new `Intl.DateTimeFormat` for each of 20,000 usage events.
A separate diagnostic run took 178 ms to consume the public full stream without aggregation, 1,203 ms inside report aggregation, 6.7 ms for discovery, and about 1.3 ms to finish/serialize the report.
These phase figures come from individual diagnostic runs, not the repeated comparison below.

The reporter now constructs one formatter per report, validates native timestamps independently, and avoids calendar conversion when no date bounds are requested.
Ignored record/metadata/non-usage frames return before session-key lookup and serialization.
Missing and invalid timestamps still have identical undated counts, and date filters retain inclusive IANA calendar-day behavior across DST boundaries.
No timestamp or source fact is substituted.

The second hotspot is unnecessary event delivery when native assistant records contain many content blocks.
The content workload adds sixteen copies of the assistant text block from `fixtures/claude/simple.jsonl` to each usage row: 20,000 records, 340,000 events and 400,000 full-stream frames.
The Usage report needs only the 20,000 usage events and source diagnostics.
The optional public `OpenSession.select({ events: ['usage'], records: false, metadata: false })` now routes these through the same JSONL reader and provider parser while delivering only the required frames.
Shared message mapping skips conversion of unselected user/assistant content; ingestion skips unselected event envelopes and frame delivery.
Canonical sequence numbers still advance for omitted events, so selected events retain the original sequence and record association.
Tool call/result tracking, identity checks, unsupported/malformed diagnostics, companion files, record limits, cancellation and compressed-source validation remain active.
All native JSON is still read and decoded; this is not a token substring scanner or another provider parser.
Other source formats and third-party handles keep the existing full-stream fallback.
The owner, alternatives and compatibility decision are in [the architecture contract](architecture.md#selective-frame-delivery).

### Repeated comparison with identical complete Huihua reports

[Raw measurements and source/input hashes](benchmarks/usage-selection.json) record all 70 measured child-process runs.
The environment is the same Linux/Node/ccusage environment described above.
Each input has 20,000 unique usage rows, fixed four output tokens, the same source path for every variant, UTC and inclusive 2026-01-01 date bounds, JSON and no pricing.
The usage-only input is 6,186,670 bytes and the content input is 15,386,670 bytes.
Input preparation is excluded from timing.
One warmup per variant precedes seven fresh-process measurements; variant order rotates and reverses across repetitions, with one process running at a time.
The benchmark worker imports the public Huihua entry point, performs discovery, opens and consumes each source through the public contract, invokes the real Usage report builder and emits its full JSON.
Timing runs from child spawn to process close, first-result latency is first stdout byte, and child kernel VmHWM is sampled every 2 ms.
The sampled peak can miss a late peak if the process exits between samples.
Profiles, stage instrumentation and repository tests are run separately from these timed repetitions.

The baseline uses the saved original reporter and pre-selection built Huihua entry point from this task.
Report-only uses the final reporter with that same old entry point; full-stream uses the final core with full frame delivery; selected uses both optimizations.
Every Huihua variant and every repetition produced byte-identical complete JSON for its input, checked using SHA-256.
These before/after Huihua results therefore compare the same input and reporting semantics.
Output size is 5,795 bytes for usage-only and 5,799 bytes for content; the small difference from the initial experiment is the temporary provenance path.

| Input      | Variant                     | Full output, ms | First result, ms | Peak RSS, KiB |
| ---------- | --------------------------- | --------------: | ---------------: | ------------: |
| Usage-only | Original baseline           |           1,730 |            1,723 |        97,388 |
| Usage-only | Report-only optimization    |             406 |              399 |        91,180 |
| Usage-only | Final core, full stream     |             390 |              384 |        95,504 |
| Usage-only | Final core, selected stream |             368 |              362 |        91,084 |
| Content    | Original baseline           |           2,465 |            2,459 |       115,316 |
| Content    | Report-only optimization    |             762 |              753 |       101,564 |
| Content    | Final core, full stream     |             781 |              773 |       107,384 |
| Content    | Final core, selected stream |             465 |              459 |        93,272 |

All figures are medians of seven runs.
The final path takes about 4.7 times less time for usage-only and 5.3 times less time for content than the original reporter.
On content, selection alone reduces elapsed time from 781 to 465 ms (about 40%) relative to the final full-stream control.
Selection has less benefit on usage-only, where there are no message content events to avoid.
Process memory includes runtime/import/GC costs; the final full-stream control's RSS is somewhat higher than the report-only control, so the additive capability is not claimed to improve every default full-stream workload.

The same runs measured ccusage at 57.2 ms / 37,668 KiB for usage-only and 142.7 ms / 58,180 KiB for content, with first results at 56.8 and 142.2 ms respectively.
ccusage still emits a different 629-byte daily total/model report; its shared output-token quantity is 80,000, while Huihua preserves 20,000 native observations and bounded samples rather than adding them.
Those timings are a secondary observation, not a claim that both products generate the same report or that Huihua is faster.
The synthetic samples have no replay, fork, duplicate request, cumulative snapshot or native cost complexities; they do not establish production workload performance.

A final selected-content CPU profile distributed the remaining sampled self time across UTF-8/line processing (46 ms), native JSON parsing (33 ms), report accumulation (37 ms), calendar conversion (25 ms) and scalar traversal (21 ms), rather than one large initialization hotspot.
A diagnostic selected-content run delivered 20,000 frames, spent 347.5 ms consuming them including 121.5 ms in report accumulation, and spent 4.8 ms scanning.
Discovery is already small in these samples; bypassing it would lose supported source discovery for little measured gain.
Parsing native records and preserving diagnostics remain required by the public contract.
Future optimization of metadata packaging, field accumulation or startup needs its own profile and a broader authorized workload; these results do not support native cores, indexes or a shadow provider parser.

Selection regression coverage compares 49 JSONL/compressed fixtures against full frames, including native records when requested, original sequences, duplicates, companion evidence and diagnostics.
Focused lifecycle cases cover lazy open, source replay, early return before an oversized suffix, an empty selection that must still validate the source, and cancellation after a usage yield.
CLI tests compare complete reports from optimized reads and buffered-provider fallback with full-stream aggregation; timezone tests exercise DST and invalid native timestamps.
Static v1 goldens remain unchanged, and installed-package/type checks expose selection as an optional public capability.
