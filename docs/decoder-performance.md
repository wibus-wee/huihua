# Decoder performance

Measured on 2026-10-09 in a Linux x64 container with Node v24.19.0, an Intel Xeon Platinum 8573C
and five visible logical CPUs.
Results are observations from this environment, not performance guarantees for arbitrary decoders.

## What changed

The original PR repeatedly copied a growing parent-candidate array and reconstructed every
namespace for each metadata contribution, even when the consumer omitted metadata.
The revised runner appends candidates privately and publishes one final aggregate at successful EOF.
Event contributions remain incremental; source evidence and final metadata/provenance remain intact.
This deliberately adjusts the unmerged opt-in metadata stream: intermediate decoder namespace
snapshots are no longer published, and interrupted streams have no final aggregate.
It does not change the default provider or existing v1 goldens.

When metadata is unselected, the runner skips namespaces and candidate evidence arrays while
retaining distinct parent IDs required for validation.
Native mapping requests selected keys plus parentSessionId, instead of forcing all metadata.
Decoder invocation no longer creates a forwarding closure for every decoder on every row.

## Method and limits

[Raw measurements](benchmarks/decoder-performance.json) contain all 150 trials, commands,
source hashes, runtime details and the benchmark harness hash.
The baseline is fe3c370abfb0b70225dae846139996396a12a8af, the original PR #30 implementation.
Each configuration has five fresh-process trials; before/fixed order alternates within each pair.
Variants execute sequentially using the same tools/bench-stream.ts harness and 64 KiB acquired chunks.
Pi stream/parse trials warm with 2,000 rows, then force GC before timing.
File-backed selection warms with one full replay of the prepared file; file creation is excluded.
Module loading, fixture preparation, warmup and explicit pre/post GC are outside elapsed time.

pi-messages repeats the native user message from fixtures/pi/simple.jsonl.
All configured decoders perform inexpensive type/customType checks and miss that message.
pi-custom repeats a synthetic custom record; exactly one decoder contributes a subagent event.
pi-parents uses the same synthetic record; exactly one decoder contributes both metadata and
an explicit parent ID on every row, retaining every evidence occurrence of that same ID.
These custom records are stress inputs, not a claimed pi-subagents producer format.
Full stream consumers count frames without retaining them.
parse retains a complete Session while its heap is sampled.
select uses the existing file-backed consume() API with events=[], records=false and metadata=false;
unknown diagnostics are still delivered and decoder input counts are validated.

GC counts and durations cover in-run Node performance GC notifications; explicit GC is excluded.
Stream heap samples occur every 4,096 records, selected heap samples every 4,096 diagnostics,
and an additional sample is taken at completion.
These are sampled peaks, not exact maximum heap usage.
Process peak RSS includes startup and warmup, so it is not isolated decoder memory.
This shared environment has substantial timing variation; tables show medians and elapsed-time IQR.
Actual extension computation, giant payloads, compressed sources and retained full frame histories
are not measured by these inexpensive callbacks.

## Ordinary messages and decoder counts

Times are milliseconds for 100,000 native Pi messages.
GC columns are median in-run collection counts; each trial has the same 100,000 canonical events.

| Decoders, all miss | Before median (IQR), ms | Fixed median (IQR), ms | Before / fixed GC count |
| ------------------ | ----------------------- | ---------------------- | ----------------------- |
| 0                  | 693.3 (577.0–809.9)     | 576.4 (542.9–795.6)    | 141 / 141               |
| 1                  | 612.5 (573.9–659.3)     | 633.2 (612.5–757.8)    | 146 / 142               |
| 10                 | 632.8 (574.7–638.9)     | 656.7 (600.4–779.3)    | 166 / 142               |
| 50                 | 763.4 (681.7–958.2)     | 720.6 (662.9–867.6)    | 257 / 142               |
| 100                | 788.6 (758.8–823.4)     | 758.7 (711.1–764.3)    | 373 / 142               |

The zero-decoder timing ranges overlap broadly, and its measured GC counts are identical.
The difference between their medians does not establish a default-path speedup.
The fixed runner still invokes every configured decoder: dispatch is O(records × decoders).
The revised invocation avoids forwarding closures and measured GC counts stay nearly stable as
decoder count grows; arbitrary callback work and the linear dispatch cost remain.

## Matched extension events

100,000 synthetic custom records produce 200,000 canonical events: retained builtin unknown events
plus one decoder subagent event per record.

| Configured decoders, one matches | Before median (IQR), ms | Fixed median (IQR), ms | Before / fixed GC count |
| -------------------------------- | ----------------------- | ---------------------- | ----------------------- |
| 1                                | 706.5 (557.3–723.4)     | 627.7 (625.8–627.7)    | 168 / 165               |
| 50                               | 665.6 (639.0–759.5)     | 627.1 (626.0–719.2)    | 281 / 166               |
| 100                              | 748.3 (743.1–754.3)     | 623.4 (622.9–921.9)    | 396 / 166               |

The ranges are noisy and overlap; these medians do not establish that 100 decoders are as cheap
as one for every workload.
The dense candidate tests below expose the much larger avoidable copying cost.

## Dense metadata and parent candidates

Each row contributes a metadata snapshot and a parent candidate.
Memory and GC columns show before / fixed medians; elapsed times show median (IQR).

| Workload                                      | Before, ms             | Fixed, ms           | Sampled peak heap, MiB | Process peak RSS, MiB | GC count |
| --------------------------------------------- | ---------------------- | ------------------- | ---------------------- | --------------------- | -------- |
| 5,000 records, stream, 1 decoder              | 92.7 (84.5–119.4)      | 42.3 (40.4–42.6)    | 16.0 / 14.7            | 88.6 / 80.0           | 57 / 8   |
| 10,000 records, stream, 1 decoder             | 200.5 (189.7–201.6)    | 89.8 (74.2–91.1)    | 21.1 / 14.7            | 102.8 / 80.8          | 143 / 16 |
| 20,000 records, stream, 1 decoder             | 1794.7 (1501.2–1816.0) | 162.0 (160.2–207.8) | 49.9 / 16.5            | 183.4 / 88.6          | 238 / 24 |
| 40,000 records, stream, 1 decoder             | 9025.3 (8904.7–9085.6) | 296.7 (257.1–318.3) | 122.7 / 21.6           | 270.9 / 93.6          | 440 / 38 |
| 20,000 records, metadata omitted, 1 decoder   | 1408.9 (1394.7–1492.3) | 78.4 (78.0–79.9)    | 45.7 / 17.3            | 232.5 / 92.1          | 98 / 7   |
| 20,000 records, metadata omitted, 50 decoders | 1606.5 (1375.1–1671.3) | 91.4 (89.6–94.9)    | 81.2 / 18.9            | 230.1 / 92.0          | 100 / 8  |
| 20,000 records, snapshot, 1 decoder           | 1475.3 (1445.0–1527.1) | 165.8 (161.7–196.7) | 78.0 / 29.1            | 228.1 / 116.0         | 172 / 12 |

At 40,000 rows, median elapsed time falls from 9.03 s to 0.297 s, about 30.4 times faster.
Median in-run GC time falls from 879.0 ms to 23.5 ms.
The original list-copying path has quadratic cumulative work; the revised append/publication path
has linear candidate aggregation work.
The revised full stream produces 4N+2 frames instead of 6N+1 in this workload because aggregate
metadata is published once rather than twice per row; the comparison includes that documented
publication change as well as allocation improvements.
Every native record, canonical event, unknown diagnostic and parent candidate is retained.
Full metadata still requires O(candidate occurrences) memory for provenance, and snapshots still
retain all records/events/diagnostics; neither API promises constant memory.
Metadata-free selection avoids the provenance array but still tracks distinct parent IDs.

## Reproduce

Use the same Node runtime and isolated source checkouts; replace the entry argument with the
checkout's src/index.ts to compare implementations.

```sh
node --expose-gc tools/bench-stream.ts stream 100000 65536 pi-messages src/index.ts 50
node --expose-gc tools/bench-stream.ts stream 100000 65536 pi-custom src/index.ts 100
node --expose-gc tools/bench-stream.ts stream 40000 65536 pi-parents src/index.ts 1
node --expose-gc tools/bench-stream.ts select 20000 65536 pi-parents src/index.ts 50
node --expose-gc tools/bench-stream.ts parse 20000 65536 pi-parents src/index.ts 1
```

The original Codex messages/mixed modes and their existing positional arguments remain supported.
Benchmarks remain opt-in and are not run by pnpm check.
The EOF-publication regression was established before the production fix; focused decoder tests
also enforce evidence, replay isolation, selection, native lineage precedence and interruption behavior.
