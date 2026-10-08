# Live producer compatibility

This opt-in CI harness tests Huihua discovery and reading against independently inventoried,
real producer-owned stores.
Agent execution only prepares the input:
Claude Code → pinned model-api-simulator → producer-owned JSONL → Huihua scan/read/open/events.
It currently produces two independent sessions, one with a Read tool roundtrip and resume.
A successful Agent run is not a successful Huihua compatibility result.
It does not replace historical fixtures or claim all-provider compatibility.

## Ownership and isolation

`tools/producer-compat.ts` owns process execution, loopback requests and scenario assertions.
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

`tools/producer-compat-audit.ts` independently walks the isolated HOME with Node fs and decodes
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

The PR/push lane pins Claude Code 2.1.292 and simulator commit 5bdf08c.
The daily scheduled canary resolves the latest Claude Code version while keeping simulator/scenarios
fixed, and records the version in the run summary.
Failures produce CI results and synthetic artifacts,
not automatically posted issues.
Startup, scenario, producer, read and drift failures retain a stage.

## Run locally

Install the simulator at the pinned commit with its locked dependencies, and install the pinned
Claude Code package in a separate directory.
Then run:

```sh
SIMULATOR_DIR=/absolute/path/to/model-api-simulator \
CLAUDE_BIN=/absolute/path/to/producer/node_modules/.bin/claude \
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
Run locally with SIMULATOR_DIR, KIMI_BIN and optionally COMPAT_REPORT set, then
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
