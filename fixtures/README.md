# Compatibility fixtures

| File | Owner / validation |
| --- | --- |
| cases.json | Historical provider manifest: 52 native cases and immutable v1 baseline paths |
| provider-cases.json | New synthetic provider cases with TypeScript snapshots only; no invented historical baselines |
| *.jsonl / legacy-files/**/*.json | Minimal handwritten synthetic schema examples; not collected private sessions |
| *.sql | Native database source of truth |
| *.db / *.sqlite | Explicit pnpm fixtures --regenerate output; tests compare logical rows against SQL |
| deepseek/compressed/session.v4.jsonl.zstd | tools/compressed-fixture.ts --regenerate output from the plain DeepSeek v4 source; independently produced checksummed frames |
| codex/simple.jsonl.zst | Historical generated compressed copy of simple.jsonl; tested byte-for-byte after decompression |
| *.golden.json | Immutable v1 semantic compatibility baselines; current validation never rewrites them |
| *.ts.golden.json | Canonical TypeScript snapshots, explicitly updated by pnpm goldens --update |

Change the native source first, run the owning task and review semantic output. Never hand-edit
DBs, dist declarations or goldens. Do not blindly update snapshots to resolve a failing test.
Node's builtin SQLite is an independent test/fixture producer; the distributed library does not
import it. Database byte layouts may differ between SQLite versions without changing semantics.
The checksummed binary fixture has a small source recipe; tools/compressed-fixture.ts --regenerate
uses Node 24.2+ builtin Zstandard as an independent producer, never as a production decoder.
Regenerating the historical compressed fixture requires a Zstandard producer outside the runtime;
the source/decompressed comparison remains mandatory.

Each provider covers conversations, tools, failures, interruption, unknown records, malformed
input and schema variants. Pi retains branches; Claude covers sidechains; database fixtures
cover generations and partial migrations. Temporary tests cover large transcripts, cancellation,
WAL, overflow/btree pages, source preservation and path boundaries without storing large fixtures.
[Compatibility decisions](../docs/architecture.md#provider-coverage-and-format-ownership) links provider research and behavior tests.
Synthetic fixtures do not certify every product release; authorized, anonymized real historical
samples remain a valuable future addition.
