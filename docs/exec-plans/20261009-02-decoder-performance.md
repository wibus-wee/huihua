# Decoder performance follow-up

## Purpose / Big Picture

Measure decoder overhead and remove repeated copying of growing parent-candidate arrays and
unselected metadata construction in PR #30.
The user's request to investigate performance follows the proposed measurements and fixes.
It authorizes the focused benchmarks in this plan; no other profiling or benchmark workload is needed.

## Progress

- [x] 2026-10-09: Inspect the existing runner, selection contract and benchmark harness.
- [x] 2026-10-09: Measure the unchanged PR implementation from isolated commit fe3c370.
- [x] 2026-10-09: Establish the focused failure: 64 candidate rows publish 128 aggregates, not one.
- [x] 2026-10-09: Fix EOF aggregation, selection-aware allocation and forwarding closures;
      all twelve focused decoder tests and strict type checks pass.
- [x] 2026-10-09: Finish 150 alternating fresh-process before/fixed trials across 15 configurations.
- [x] 2026-10-09: Pass the complete pinned pnpm check with 445 tests and installed-package verification.
- [ ] Update PR #30 with the fix, measured results and EOF-publication contract.

## Surprises & Discoveries

Every parent contribution copies its entire prior candidate list and publishes that growing list.
Every metadata contribution reconstructs all decoder namespaces, including when delivery is disabled.
The current opt-in metadata stream exposes intermediate aggregate snapshots; deferring aggregate
publication to successful EOF avoids copying published snapshots and preserves final state.
At 40,000 dense candidate rows, baseline median time is 9.03 seconds versus 0.297 seconds after
the fix; median sampled heap falls from 122.7 MiB to 21.6 MiB.
Ordinary message timings vary substantially in the shared container; no default-path speedup
is inferred from overlapping ranges or from one configuration's median alone.

## Decision Log

- Keep event contributions incremental and original records shared by reference.
- Aggregate decoder metadata privately, publish final namespaces once at successful EOF, and
  document this adjustment to the unmerged API rather than silently changing frame merge rules.
- Preserve every parent candidate and its evidence; do not deduplicate or mutate published output.
- When metadata is unselected, retain only candidate IDs required for lineage arbitration.
  Decoder callbacks and input evidence remain independent of selection.
- Reuse tools/bench-stream.ts, existing Pi fixtures, sequential fresh processes and Node GC metrics.
  No new dependency or parser is required.

## Outcomes & Retrospective

Aggregation is now linear in candidate occurrences and skipped when metadata is omitted.
All callbacks still run independently of output selection, with original evidence and incremental events.
Final decoder metadata is deliberately published once at successful EOF.
Raw measurements and limitations are recorded in docs/decoder-performance.md and its linked JSON.
Full repository acceptance passes with 445 tests and installed JavaScript/TypeScript verification.
The measured production source hashes still match the final implementation.
The PR update remains pending.

## Context and Orientation

src/shared/decoders.ts owns aggregation; src/shared/ingestion.ts owns replay and output selection.
tests/decoders.test.ts checks evidence and lifecycle behavior.
tools/bench-stream.ts measures acquisition using bounded repeated fixture blocks.
The unchanged PR commit is fe3c370; its source is isolated in /workspace/work/pi-decoders-before.

## Plan of Work

Extend the existing acquisition benchmark with Pi message, custom-event and dense parent/metadata
workloads and configurable decoder counts, including metadata-free file selection.
Measure the original implementation, add a failing EOF-publication regression, then replace
per-contribution snapshots with private aggregation and selection-aware allocation.
Repeat fresh-process comparisons and publish raw results and their limits in docs.

## Concrete Steps

Run node --test tests/decoders.test.ts for the focused regression.
Run node --expose-gc tools/bench-stream.ts with documented Pi arguments and source entry points.
Run npm exec --cache /workspace/work/npm-cache --package=pnpm@12.4.2 -- pnpm check for acceptance.
Benchmark variants execute sequentially; fixtures and stores remain unchanged.

## Validation and Acceptance

Normal EOF publishes one decoder namespace snapshot containing latest metadata and every candidate.
Cancellation, errors and early return publish no final decoder aggregate.
Event order, source references, original evidence, native lineage and conflicts remain correct.
Selected outputs equal full output followed by filtering.
Measurements cover no decoder, few/many misses, matched events and dense candidate growth;
time, sampled heap, process RSS and in-run GC are recorded without claiming fixed guarantees.

## Idempotence and Recovery

The baseline checkout is read-only.
Generated benchmark inputs use temporary files and are removed on completion.
No native store, dependency lockfile or v1 golden changes.

## Artifacts and Notes

docs/decoder-performance.md will describe workloads, machine, commands and measured limitations.
docs/benchmarks/decoder-performance.json will retain raw trials and source identities.

## Interfaces and Dependencies

SessionDecoder callbacks and contribution types remain unchanged.
Decoder metadata becomes final EOF state; events remain incremental.
Shared ingestion passes FrameSelection to the runner and requests native parent lineage even
when that field is not delivered.
There is no new public dispatch/filter API without evidence that it is required.

Revision: initial performance follow-up plan, 2026-10-09.
