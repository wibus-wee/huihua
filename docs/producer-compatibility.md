# Live producer compatibility

This opt-in CI harness tests Huihua discovery and reading against independently inventoried,
real producer-owned stores.
Agent execution only prepares the input:
Native CLI / official recorder → pinned model-api-simulator → producer-owned disk records → Huihua scan/read/open/events.
The manifest declares the exact producer, wire protocol, journey, and remaining gaps for every registered provider.
A successful Agent run is not a successful Huihua compatibility result.
It does not replace historical fixtures or claim all-provider compatibility.

## Ownership and isolation

`tools/producer-compat/claude.ts` owns process execution, loopback requests and scenario assertions.
Huihua production code remains read-only and has no new dependencies or runtime-control API.
Huihua is exercised only through public session entry points; the harness never fabricates or repairs
the live stores.
A test-only independent inventory reads their bytes for comparison.
The simulator and CLI are installed separately from Huihua's dependency graph.
This adds no runtime dependency or alternate production parser.

Each attempt creates a fresh HOME/config/workspace, uses a synthetic key and loopback model URL,
and launches Claude in bare mode with nonessential traffic disabled and only Read allowed.
The scenario reads a generated sentinel file; no real credentials or user stores are inherited.
The simulator CLI's model and control listeners use adjacent loopback ports; the default test ports
are 18887/18888.
Use SIMULATOR_PORT to select another pair.
The explicit queued replies and expected final text prevent an automatic fallback reply from passing.
The CLI reports synthetic model-cost estimates; no paid model endpoint is configured.

## Checks and evidence

`tools/producer-compat/claude.ts` independently walks the isolated HOME with Node fs and decodes
JSONL with TextDecoder and JSON.parse.
It does not import Huihua's walker, line framer, provider,
or mapper.
Expected session IDs come from the scenario, not scan output.
Unexpected JSONL without
one native identity fails inventory review rather than disappearing through the provider's filters.
This deliberately small oracle supports this isolated Claude scenario only; it is not a discovery
framework or a second general provider implementation.

- Compare the complete session inventory against scan: provider, source path, format and ID;
  missing, duplicate and extra refs fail.
- For every source, compare every nonblank physical row against records: count, order, sequence,
  original text (including line endings), complete native value, provider, path and physical line.
  Raw text retains number spellings that JavaScript numbers cannot represent exactly.
- Verify every event's source record, ID, timestamp and explicit envelope lineage.
  Check exact
  same-record text, model, tool arguments/results, call IDs, error flags and complete native usage;
  unsupported record types retain complete unknown payloads.
  Check created/updated/workspace facts.
- Run the independent assertions against read, snapshot, streamed records and streamed events;
  agreement between Huihua interfaces alone is not the oracle.
- Negative output mutations cover missing/duplicate/reordered rows, lost fields/text, wrong physical
  lines, missing events, wrong associations/times/identity and corrupted text/tool/usage/unknown data.
  These tests alter copies of outputs, never the live Agent stores.

The semantic assertions intentionally cover the produced text/tool/usage surface, not every
possible Claude block.
A new unreviewed content shape stops the check for review; raw evidence
preservation alone does not establish normalization support.
Diagnostics still distinguish known
unsupported metadata.
Source generation/inventory failures are not labeled Huihua parser defects.

The test requires discovery without scan failures, preserved user/assistant sentinels, exact tool
arguments, matching call/result IDs and ordering, successful tool output, and equality between
read(), open().snapshot() and open().events().
It reports unknown types/counts, diagnostics, structured fallback blocks and value-free native
field/type paths, collected directly from disk before Huihua parsing.
The checked-in baseline comes from the pinned real producer, not an invented store.
Paths are additionally grouped by outer native record type so a field in one record type cannot
mask its disappearance or type change in another.
New unknown types, increased unknown counts, structured fallback growth, extra diagnostics or
field/type drift fail distinctly at the compatibility-baseline stage.
Existing known unknown records remain raw evidence, not newly supported semantics.

Field paths are structural observations, not an authoritative inferred JSON Schema.
An added optional
field can intentionally trigger review without constituting a breaking change.
Missing expected text
or tool semantics is a hard failure even if unknown counts do not increase.
Baseline updates require inspecting the report and native evidence; the harness never auto-accepts them.
Unknown events and their diagnostics are not counted as two separate unknown records.

Pinned versions and the simulator commit are owned by tools/producer-compat/manifest.json.
The daily scheduled canary resolves the latest Claude Code version while keeping simulator/scenarios
fixed, and records the version in the run summary.
Producer jobs emit CI results and synthetic artifacts; the trusted daily reporter described
below owns issue publication.
Startup, scenario, producer, read and drift failures retain a stage.

## Run locally

Install the simulator at the pinned commit with its locked dependencies, and install the pinned
Claude Code package in a separate directory.
Then run:

```sh
SIMULATOR_DIR=/absolute/path/to/model-api-simulator \
PRODUCER_BIN=/absolute/path/to/producer/node_modules/.bin/claude \
COMPAT_REPORT=/tmp/producer-compat-report.json \
pnpm test:producer-compat
```

The harness requires Node 24.
Its output includes the isolated artifact directory.
Data is synthetic,
but inspect artifacts before sharing them.
This test is opt-in and is not run by ordinary pnpm check.

## Current limits

A Codex 0.160.1 pilot on the development host failed before model requests because its app-server
sandbox helper rejected the socket directory.
This is an environment/startup blocker, not a Huihua
parse result.
Codex is not silently skipped or marked green in this workflow; no Codex CI lane is
claimed yet.
Tool failures, cancellation, compaction and other providers remain future scenarios.

## Cross-host calibration

The first GitHub-hosted run completed the semantic journey but failed the initial local baseline.
Inspection of its synthetic native JSONL showed an extra initialization `last-prompt` and
`atis-latch` record.
Observed maxima are therefore 3 and 2 respectively; other unknown counts
remain unchanged.
The attachment's `context.gitStatus` string was absent on GitHub's runner,
so that one field path is explicitly optional.
New field paths, other missing paths and counts above
these observed bounds still fail.
This is reviewed environment variation, not automatic acceptance
of an upstream schema change. [Initial CI evidence](https://github.com/wibus-wee/huihua/actions/runs/37650773174).

## Independent audit baseline provenance

On 2026-10-08 the pinned Claude Code 2.1.292 and simulator 5bdf08c produced an 18-record
resumed session and a 9-record independent session in a fresh isolated HOME.
All 27 raw rows
passed the new independent read audit.
The 151 per-record-type paths for the original resumed
scenario were reviewed against those native files; the old ungrouped paths had no additions or
removals.
Only the already-reviewed attachment.context.gitStatus remains optional in the grouped
baseline.
Existing unknown maxima are unchanged; there is no automatic baseline-update mode.

The report includes each discovered native source and record count.
A separate `.failure.json`
records the failed stage and exact assertion, preserving any structural report already written.
Native inventory and request ledger remain in synthetic artifacts.
Exact assertions identify the
session, file and physical row; deep equality differences identify changed fields or values.

## GitHub Actions summary

The always-run summary step displays independently inventoried session and raw-row counts,
plus separate scan, read, snapshot, record-stream, event-stream, scenario and baseline results.
A check passes only after every native source has passed that check.
Failed and unrun checks
remain distinct; producer/setup failures do not imply a Huihua parser failure.
The progress sidecar retains completed checks and the failing stage/assertion.
Missing progress after setup failure or interruption cannot produce a successful summary.
Detailed reports and synthetic evidence remain in the run artifact.
This presentation is CI-only
and does not change the library API or compatibility baseline.

## Kimi live lane

The independent `kimi` job pins Kimi Code 2.1.1 for PR/push runs; scheduled canaries
resolve its latest npm release.
It tests the PR checkout, not a downloaded Huihua release.
Kimi runs with a fresh HOME, telemetry/title generation disabled and a synthetic
loopback Anthropic provider, then persists a first turn and a resumed reply.
No tool or subagent is requested by the simulator.

The harness independently inventories wire.jsonl and state.json, verifies scan identity,
and compares raw native values before checking the two persisted assistant messages
against read, snapshot, record streaming and event streaming.
The reply oracle reads `agent.message.appended.message.message` directly from disk;
missing, changed, reordered or duplicate normalized replies fail.
It is scenario-local, not a full Kimi parser or a baseline for all Kimi shapes.
There is no expected-failure allowance or continue-on-error: a compatibility defect makes
this job red while the ordinary quality suite can still pass.
Summary and artifacts run even on failure, preserving exact stage and source evidence.

The published Huihua 0.4.0 reproduced zero normalized assistant messages for two
native Kimi replies on 2026-10-08; raw values were preserved as unknown evidence.
The live lane guards this behavior without changing the provider implementation.
Run locally with SIMULATOR_DIR, PRODUCER_BIN and optionally COMPAT_REPORT set, then
`pnpm test:producer-compat:kimi`.

## Codex live lane

The Codex job pins CLI 0.161.0 and uses the OpenAI Responses simulator, a fresh
HOME/CODEX_HOME and workspace-write sandbox by default.
It requests only a deterministic read of a synthetic file, then resumes the same
thread for a second reply.
It never delegates repository work or uses real model credentials.
The oracle independently inventories native rollout JSONL, compares every raw row,
checks same-record messages and tool call/result IDs, and requires both reply sentinels.
Codex's mirrored event_msg and response_item evidence is not silently deduplicated.

The native shape/unknown/diagnostic baseline must be reviewed against a real writer run.
A missing baseline is a failing review gate, not an expected-failure exemption.
Startup errors are reported separately and never counted as parser failures or passes.
Synthetic output and failure evidence are uploaded even when a stage fails.
The development cloud's 0.161.0 pilot failed before model requests because the
app-server sandbox rejected its socket directory; GitHub runner verification is required.
The user approved disabling the inner Codex sandbox only for this synthetic GitHub job
on 2026-10-08 after its shell read failed with bwrap loopback Operation not permitted.
Both GITHUB_ACTIONS=true and CODEX_COMPAT_UNSANDBOXED=1 are required for that override;
local runs keep workspace-write.
No credentials, real workspace data or upstream model endpoints are used.

### Codex baseline provenance

Reviewed the real Codex CLI 0.161.0 run at commit b905038 on 2026-10-08:
[calibration evidence](https://github.com/wibus-wee/huihua/actions/runs/37727960950).
It persisted one resumed rollout with 29 rows; raw acquisition, both replies, a successful
synthetic file read and resume passed before the deliberately missing baseline review gate.
The reviewed baseline contains 214 ungrouped and 248 outer-record-type field paths,
zero structured fallback blocks, and ten PartialParse diagnostics corresponding to
known unknown evidence: task_started (2), world_state (1), item_completed (5), and
thread_settings_applied (2).
These are retained lifecycle/state or mirrored item records, not newly supported semantics.
Canonical assistant replies and tool outputs are independently checked against response_item
rows, so accepting these known unknowns does not excuse missing message content.
There are no optional field paths, automatic updates or widened unknown limits.

## Daily tracking and incident issues

Daily schedule: 05:17 UTC (13:17 Asia/Shanghai).
After this workflow is merged to the default branch, each provider runs both pinned and
latest CLI lanes against the same Huihua commit; PR/push runs keep pinned lanes only.
Manual runs can choose both lanes and opt into issue publishing on the default branch.
The live jobs have read-only repository permissions and separate synthetic artifacts.
A default-branch-only publisher has issues:write and never installs or executes artifacts;
it reads validated structured lane results, not native stores or arbitrary scripts.
No issue is published from pull requests or non-default branches.

One fixed issue, identified by `huihua-daily-compatibility:v1`, holds the current six-lane
matrix and one bot-owned history comment per UTC day.
Re-runs update that day's bot comment; human notes outside the managed body section remain intact.
Missing, duplicate or wrong-commit artifacts are incomplete, never passing.
Provider versions, the Huihua commit, stage, native counts, Actions links and uncovered
Kimi/tool/schema scenarios stay visible even when all implemented checks pass.

Anomalies use provider, verdict, stage and a normalized error fingerprint for deduplication
across pinned/latest, versions, temporary paths and run timestamps.
Read failures, schema review and environment/incomplete incidents are titled distinctly;
an issue is not an automatic claim of a Huihua parser root cause.
Existing incident issues receive a dated evidence comment, including closed incidents;
the publisher does not automatically close or reopen any issue.
A closed daily tracker stops publication for manual review.
Failed or uncertain writes are not blindly retried; later runs reconcile stable markers first.
It never accepts a baseline automatically or patches product code.

The publisher supports read-only preview with COMPAT_PUBLISH unset; production writes
require schedule/workflow_dispatch on the default branch plus an explicit publish flag.
The reporter classifies missing/stale/duplicate results, preserves managed text boundaries,
deduplicates incidents and escapes Markdown/mentions.
Layout is reviewed through a read-only
preview, not a separate unit-test suite for each reporting script.
The dashboard leads with actionable exceptions, then three provider rows with pinned/latest
columns, explicit coverage gaps and collapsible evidence.
Native counts are evidence, not a score.

Evidence upload is part of daily completeness: successful parser checks with failed
artifact delivery produce an incomplete lane, not a daily PASS.
Codex uploads only stable reports, native rollouts and the synthetic input file;
its background plugin-clone locks and unrelated runtime databases are excluded.
The 2026-10-08 PR validation exposed a disappearing .git/shallow.lock during archive
creation; narrowing evidence paths fixes that delivery race without weakening parsing checks.

## Reviewed Claude 2.1.293 permission metadata

[Issue #19](https://github.com/wibus-wee/huihua/issues/19) was produced by the
[2026-10-08 six-lane run](https://github.com/wibus-wee/huihua/actions/runs/37737328660).
Claude 2.1.292 passed; 2.1.293 preserved two sessions and 31 rows, passed discovery,
read/snapshot/stream, tool roundtrip and resume, then failed the native shape baseline.
Its user/tool-result row added permissionDecision with decision=accept, source=config
and reasonType=rule.
Only this object and these three string paths are accepted as reviewed optional fields,
including their user-record grouping; other additions, type changes and missing required
paths still fail.
The pre-existing optional gitStatus path is unrelated.
Raw preservation does not establish that permission semantics are fully represented by
canonical events, and this automatic config/rule decision is not evidence of human approval.
No production mapper or event schema changes are included.

Native shape failures carry an explicit added/removed path diff through progress and lane
results into the Summary and incident report.
Reports bound visible paths and retain the complete diff in synthetic artifacts.
Distinct path diffs receive distinct incident fingerprints; unchanged diffs still deduplicate
across lanes and runs.

## All-provider manifest and reusable runners

`tools/producer-compat/manifest.json` is the inventory of all 20 registry providers.
A policy test rejects omissions/duplicates.
The workflow derives its matrix from
that file; the same entries drive installation, required checks, job summaries,
and the daily dashboard.
A missing result cannot make an enabled lane disappear.
Disabled entries remain visible as NOT CERTIFIED with a concrete reason.

- `catalog.ts` resolves pinned/latest installations and records exact versions,
  executable hashes, manifest hash, source, and simulator commit in an installation manifest.
  Native fx/Grok pinned binaries are hash-checked; Python/Hermes pins an upstream
  commit and uses its frozen lockfile.
  The publisher imports only data/Node-builtins,
  installs no packages, and does not execute downloaded evidence.
- `live.ts` shares isolated HOME/config, real first-turn/resume execution, expected
  simulator replies, and bounded process cleanup across the CLI producers.
- `native.ts` owns scenario-scoped independent oracles: Node filesystem/JSON,
  Node's native SQLite reader, and the zstd executable.
  It never imports Huihua's
  discovery, decoder, or mapper.
  Native rows and assistant text/record association
  are checked across read, snapshot, streamed records, and streamed events.
- `recording.ts` records actual Qwen ACP JSON-RPC and official OAR voyages from
  a Pi runtime.
  These are format+producer checks, not fabricated notifications,
  and do not certify all ACP servers or every OAR runtime.
  Both currently cover
  a first turn, not process-restart resume.

Cline 3.0.70's `--id` switches to interactive mode and clears the prompt, so its
`--json` resume is rejected by the producer.
Its first-turn lane declares that gap.
New lanes do not inherit Claude/Codex's tool or reviewed native-baseline claims.
The model replies are deterministic local protocol scenarios; no paid model or
real account credential is used.
Native tools need their own runtimes (including
Python 3.14 for Hermes); these are test-only, not Huihua dependencies.

### Verified discovery from the new live checks

On 2026-10-08, fx 0.0.13 wrote a schema-version-4 `session.json` plus an
`events.jsonl` containing both sentinel replies in one resumed conversation.
Huihua discovered the native ID, but `read` raised `UnsupportedSchema: unsupported
fx snapshot schema`.
The old reader expected schema version 3 and checkpoint snapshots.
The fx parser now reads schema-4 metadata with the current conversation log while preserving the legacy snapshot path.
The captured regression first reproduced that failure; a fresh fx 0.0.13 first-turn/resume run then passed scan/read/snapshot/records/events, independently matching all seven native records.
No continue-on-error, fabricated old store, or automatically accepted baseline hides the failure.
Tool roundtrip and reviewed shape-baseline certification remain explicit gaps.

## Primitive-review inputs

Every successful read emits `primitive-review.json` and
`primitive-review.prompt.txt`; a failed read emits a packet with native inventory
and an explicit unavailable canonical result.
Packets include current contract
and mapping source with hashes, producer/version/protocol, exact record pointers,
canonical events, diagnostics, and bounded neighbor context.
Complete evidence
remains in the uploaded synthetic artifacts; truncation is explicit.

The prompt distinguishes metadata-only, missing existing mapping, extension of
an existing primitive, a candidate new primitive, and insufficient evidence.
It
requires a concrete consumer need and source-record/pointer citations, and treats
all native/model text as untrusted data.
Existing unknown/raw-only records are
included even without shape drift.
A config/rule permission decision is not
assumed to be human approval.
No external LLM is called, and no review can accept
a baseline or change the public event contract automatically.

## Change-scoped PR checks

The same manifest maps source/fixture paths to provider scope labels and those
scopes to runnable lanes.
The catalog summary lists selected providers, scope
labels, selection reasons, and affected providers without a certified producer.
These scope labels are internal classifications shown in the summary; the job
has no permission to write labels onto a PR.

- A provider's code, native fixtures, or dedicated oracle/baseline selects that
  provider.
  A rename across providers selects both the old and new paths.
- Documentation, provider RESEARCH files, tests, tools/policy.ts and the usage consumer run regular
  quality checks without installing native CLIs.
- Manifest changes compare parsed base/head JSON: changed provider entries select
  those providers; formatting and provider order alone select none.
  PR comparisons use the same merge base as the path diff, not an independently advanced main.
  Global fields, inventory, availability or path-routing changes require every lane.
  Missing, malformed or unsupported comparison data also require every lane.
- Shared ingestion/contracts/registry, shared harness/selector, dependency
  changes, and any unclassified path conservatively select every runnable lane.
- Scheduled and manual runs keep the full pinned/latest matrix, independently
  of repository paths, to detect upstream producer changes.
- Manual `ci:all` or `ci:provider:ID` PR labels can only expand the selection.
  They are read fresh when a PR check runs or is rerun.
  Adding a label alone does
  not start a new workflow; rerun the check after applying an override.
  There is
  no skip label that can hide a required lane.

Native checks run on PRs and main-branch pushes, avoiding duplicate real-CLI runs
for both a feature-branch push and its PR update.
The selector uses the real Git comparison with full checkout history and
`--no-renames`, and treats missing comparison data or failed label reads as full
coverage.
An empty matrix is intentionally skipped, not an Actions matrix error.
The stable `producer compatibility result` job fails on selector failure,
selected-lane failure, or cancellation; it succeeds on a justified empty
selection without claiming any missing native-reader coverage.
Quality CI keeps
running separately.
The captured fx fix (PR #22) is a regression case: its parser, fixtures, shared
test file, policy assertions and fx-only manifest gap update now select only fx.
A PR changing the selector itself still selects all lanes to validate that shared infrastructure.
Live failures remain red whenever their scope is
selected; routing never changes an assertion or accepts a baseline.

## Reviewed Claude 2.1.295 and Codex 0.162.0 drift

The [2026-10-09 scheduled run](https://github.com/wibus-wee/huihua/actions/runs/37926896716)
at Huihua 8d7e728 passed acquisition, same-record semantic assertions, tool roundtrip and resume
for both versions, then raised [Claude #31](https://github.com/wibus-wee/huihua/issues/31)
and [Codex #32](https://github.com/wibus-wee/huihua/issues/32) at the structural baseline.
These observations concern the synthetic journey, not a complete private-format specification.

Claude 2.1.295 adds `assistant.requestedModel` (string).
In this capture it equals the requested
model; `message.model` still supplies the recorded response model.
The new outer field remains
in raw evidence and must not overwrite the response model.
Only that exact record/type path is
accepted as optional, alongside the existing reviewed permission metadata; different types or
placement still fail.

Codex 0.162.0 adds `task_started.turn_attribution` containing turn/root identifiers, `exec`
trigger and null parent/initiating-agent fields.
It omits the three old turn-context fields
`current_date`, `timezone`, `workspace_roots`, and the `CommandExecution` mirror's `stdout`,
`stderr`, `formatted_output`.
The mirror retains `aggregated_output`, exit code and command;
the `response_item.function_call_output` retains the successful tool result.
The new attribution
remains complete unknown evidence; turn context remains complete system evidence.
No new
public primitive or production parser change is justified by this journey alone.

The Codex harness owns two complete reviewed path shapes in its existing baseline file.
It reuses `assertNoProducerDrift` for each, retaining the pinned shape and all common unknown,
structured-fallback and diagnostic checks.
This is deliberately not a union of optional additions
and removals: a partial hybrid, lost tool-result path, attribution type change or unknown growth
still fails.
When neither shape matches, report the smaller exact drift for review.
Future shapes
are never accepted automatically.
Shared runtime and provider code are unchanged.

Native artifacts were checked against GitHub's SHA-256 digests before inspection:

| Artifact                                | SHA-256                                                          |
| --------------------------------------- | ---------------------------------------------------------------- |
| synthetic-producer-compatibility-pinned | 98d6e6bd66f5c9d0ecfbf8e8660a01805aeed187561785ad94e5301d44718a88 |
| synthetic-producer-compatibility-latest | c7ce0c4384886dce3e7ab72987a0f3ebf93dd8743c2b2eb4e3cc69870f2a1f6d |
| synthetic-codex-compatibility-pinned    | 827c397ffbfb35cb0ed242fc472d4a208b48a1ea2c8fbb56b2efb6080fa26a27 |
| synthetic-codex-compatibility-latest    | e8651cacbbd6ea9c3a8156422ceb1a3a268c1096813308367adb5bca3f2e5053 |

Local replay first reproduced both baseline errors with the previous code.
After this review,
all four archived captures pass scan/read/snapshot/record-stream/event-stream audits and exact
native paths: six sessions, 120 rows total.
Codex scenario assertions also pass.
Replay does not
claim a fresh CLI execution; synthetic historical captures are inputs, never repaired stores.
