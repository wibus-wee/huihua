# Live producer compatibility

This opt-in CI harness tests an actual producer, rather than replaying hand-authored stores:
Claude Code → pinned model-api-simulator → producer-owned JSONL → Huihua scan/read/open/events.
It currently covers one Read tool roundtrip, final assistant text and a resumed native session.
It does not replace historical fixtures or claim all-provider compatibility.

## Ownership and isolation

`tools/producer-compat.ts` owns process execution, loopback requests and scenario assertions.
Huihua production code remains read-only and has no new dependencies or runtime-control API.
Only public session entry points read the resulting store; the harness never fabricates or repairs it.
The simulator and CLI are installed separately from Huihua's dependency graph.
This was chosen over a runtime dependency or a second native-store parser.

Each attempt creates a fresh HOME/config/workspace, uses a synthetic key and loopback model URL,
and launches Claude in bare mode with nonessential traffic disabled and only Read allowed.
The scenario reads a generated sentinel file; no real credentials or user stores are inherited.
The simulator CLI's model and control listeners use adjacent loopback ports; the default test ports
are 18887/18888.
Use SIMULATOR_PORT to select another pair.
The explicit queued replies and expected final text prevent an automatic fallback reply from passing.
The CLI reports synthetic model-cost estimates; no paid model endpoint is configured.

## Checks and evidence

The test requires discovery without scan failures, preserved user/assistant sentinels, exact tool
arguments, matching call/result IDs and ordering, successful tool output, and equality between
read(), open().snapshot() and open().events().
It reports unknown types/counts, diagnostics, structured fallback blocks and value-free native
field/type paths.
The checked-in baseline comes from the pinned real producer, not an invented store.
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
