# Acquired JSONL stream performance

This experiment measures the incremental acquisition API and the forwarding layers in
[shared ingestion](../src/shared/ingestion.ts).
The [architecture contract](architecture.md#direct-acquisition)
owns acquisition semantics.
Timing results are observations, not compatibility or performance guarantees.

## Method

Measured on 2026-10-05 with Node 26.10.0, macOS 26.5.1, Apple M4 Max, arm64.
Each measurement runs in a fresh process, warms up with 20,000 records, then forces GC before timing.
Throughput trials use seven repetitions per configuration; memory trials use five.
Variants run sequentially in shuffled or alternating order.
The benchmark uses Node APIs without a benchmark dependency.
All recorded runs use the JSONL framer at `90d2bf573bb22e4db222c829e1dd8fc971c248e1`.
The separate framer optimizations in `de6cc0a` are retained in the current branch; their effects are not part of these recorded timings.

The `messages` workload repeats the two native messages from the Codex simple fixture.
The `mixed` workload cycles through user/assistant messages, a tool call/result, an unknown record and malformed JSON,
using the existing fixtures.
Each native line yields one event.
Native tool IDs repeat; evidence is preserved.
A fixed input block is reused, so input allocation does not grow with transcript length.
Chunks are at most the configured size; the final piece of each block can be smaller.
The consumer counts frames without retaining them or performing downstream writes.

Timing includes byte iteration, framing, native mapping and consumption; it excludes module loading, fixture preparation and warmup.
No AbortSignal is supplied in timing runs.
Cancellation and cleanup are checked separately by the acquisition tests.
These are small repeated fixture workloads without disk/network I/O, not measurements of Worker deployment, compressed/database stores or production transcripts.

[Raw CSV measurements](benchmarks/acquired-stream.csv) contain all 310 process runs.
[Experiment metadata](benchmarks/acquired-stream.json) records source and fixture hashes, trial order, runtime and contract-test outcomes.

## Ablations

The baseline is the incremental API implementation before this simplification, not the historical snapshot-only API.
Each single-component variant changes only the named component.
Times below are medians for 100,000 records and 64 KiB chunks.
Throughput gain means `baseline time / variant time - 1`; it is not the percentage reduction in elapsed time.

| Variant                                                                  | Messages, ms | Mixed, ms | Throughput gain, messages / mixed | Acquisition tests                   |
| ------------------------------------------------------------------------ | -----------: | --------: | --------------------------------: | ----------------------------------- |
| Baseline                                                                 |        253.4 |     303.3 |                                 — | 75/75                               |
| Deliver frames directly from ingestLines; move cancellation checks there |        194.3 |     249.3 |                   +30.4% / +21.7% | 75/75                               |
| Bypass the per-line source wrapper when no companion prelude is needed   |        237.4 |     288.4 |                     +6.8% / +5.2% | 75/75                               |
| Pass existing byte iterables directly to the framer                      |        254.5 |     309.3 |                     -0.4% / -2.0% | 75/75                               |
| Remove the single-consumer guard                                         |        253.9 |     307.7 |                     -0.2% / -1.4% | 74/75; replay protection fails      |
| Remove the forwarding generator and its frame cancellation checks        |        224.1 |     280.1 |                    +13.1% / +8.3% | 73/75; two cancellation regressions |
| Combine the three forwarding changes                                     |        182.3 |     233.7 |                   +39.1% / +29.8% | 75/75                               |

The extra frame generator imposes an async iterator step on every frame.
Its cancellation responsibility now belongs to ingestLines,
which also delivers file-backed frames.
No separate frame-forwarding generator is needed.
Ordinary JSONL also avoids the source wrapper's async step and line-object copy; companion-file evidence still uses the existing prelude.
Text/byte-array adaptation remains necessary, while an already acquired iterable needs no delegating byte generator.

The byte-iterable change has no clear benefit with ordinary chunk sizes.
A second seven-trial experiment isolates its small-chunk effect:

| Chunk limit | Baseline, ms | Byte delegation removed, ms | Frame and line wrappers removed, ms | All three removed, ms |
| ----------- | -----------: | --------------------------: | ----------------------------------: | --------------------: |
| 64 B        |        357.8 |                       345.9 |                               282.8 |                 270.8 |
| 4 KiB       |        304.0 |                       302.6 |                               232.4 |                 230.0 |
| 64 KiB      |        302.9 |                       301.8 |                               227.4 |                 228.4 |

Small differences across runs can be noise.
Removing the byte delegate saves 3.4% in the 64 B case and simplifies ownership without changing mapping.
The guard remains a once-per-sequence operation; removing it has no useful measured gain and loses a public guarantee.
Cancellation checks, caller-buffer copies, raw evidence, diagnostics, the shared acquisition helper and the existing snapshot collector remain.
There is no new parser, public API change or dependency.

## Final implementation

An independent paired run compares the exact final source against the saved baseline after formatting and removal of the unused byte-delegation branch.

| 100,000 records, 64 KiB chunks | Baseline median (IQR), ms | Final median (IQR), ms | Final records/s | Throughput gain |
| ------------------------------ | ------------------------: | ---------------------: | --------------: | --------------: |
| Messages, 11.30 MiB            |       253.2 (250.1–257.6) |    175.3 (175.1–176.6) |         570,484 |          +44.4% |
| Mixed, 8.89 MiB                |       300.8 (297.4–305.1) |    227.8 (227.5–230.3) |         438,924 |          +32.0% |

The final mixed-workload memory runs compare incremental consumption with a complete snapshot:

| Records | Entry point | Median time, ms | Median sampled peak heap, MiB | Median process peak RSS, MiB | Median first record available, ms |
| ------- | ----------- | --------------: | ----------------------------: | ---------------------------: | --------------------------------: |
| 100,000 | stream      |           229.5 |                          14.6 |                        102.7 |                             0.070 |
| 100,000 | parse       |           251.8 |                          94.7 |                        225.5 |                           251.797 |
| 500,000 | stream      |         1,102.9 |                          27.7 |                        119.5 |                             0.068 |
| 500,000 | parse       |         1,239.8 |                         385.1 |                        519.8 |                         1,239.702 |

Streaming samples heap every 4,096 records; snapshot mode samples while the complete Session is still reachable.
These samples are not an exact peak measurement.
Process peak RSS comes from resourceUsage and includes runtime/module loading and warmup.
GC timing affects both measurements.
No per-run confidence interval or fixed memory bound is implied.
The small first-record times measure synchronous fixture availability, not storage or network latency.
Incremental consumption avoids Session accumulation; pending tool diagnostics and provider parser state can still grow with other inputs.

## Reproduce

Run from the repository root with the pinned pnpm version:

```sh
pnpm bench:stream stream 100000 65536 messages
pnpm bench:stream stream 100000 65536 mixed
pnpm bench:stream stream 500000 65536 mixed
pnpm bench:stream parse 500000 65536 mixed
```

The command emits one JSON result.
Repeat in separate processes and compare medians; do not benchmark variants concurrently.
The optional fifth argument selects a local source entrypoint for isolated ablation copies.
The commands above measure the current checkout, including its current framer.
To reproduce the archived comparison, restore the recorded framer in an isolated copy, measure the final ingester, then apply the [baseline patch](benchmarks/acquired-stream-baseline.patch) and measure again:

```sh
bench_repo=$PWD
bench_root=$(mktemp -d)
cp -R src "$bench_root/src"
ln -s "$bench_repo/node_modules" "$bench_root/node_modules"
printf '{"type":"module"}\n' > "$bench_root/package.json"
git show 90d2bf573bb22e4db222c829e1dd8fc971c248e1:src/shared/jsonl.ts > "$bench_root/src/shared/jsonl.ts"
pnpm bench:stream stream 100000 65536 mixed "$bench_root/src/index.ts"
(cd "$bench_root" && git apply "$bench_repo/docs/benchmarks/acquired-stream-baseline.patch")
pnpm bench:stream stream 100000 65536 mixed "$bench_root/src/index.ts"
```

The source/benchmark hashes in the metadata identify this experiment; later source changes can require a new baseline patch.
Timing is a manual diagnostic, not a CI threshold. `pnpm check` continues to enforce mapping, lifecycle, architecture and installed-package compatibility.
