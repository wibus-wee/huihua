# Contributing

Use Node 22.18+ and the pnpm version pinned in package.json.
From a checkout, pnpm install installs the development toolchain.
pnpm build uses tsdown to emit ESM JavaScript and declarations; tsc only checks types.
Consumers of the tarball receive JavaScript and generated declarations;
there is no install-time compilation, native addon, Rust, WASM or downloaded binary.

```sh
pnpm install --frozen-lockfile
pnpm check
```

The repository-owned check command is also the CI entry point.
It runs eslint-config-hyoban formatting/linting, strict
TypeScript and Knip (unused files, exports and dependencies), dependency sources/licenses and layer invariants, then runs provider regression,
binary ingestion and streaming tests.
One build produces JS/declarations, followed by a temporary
pack/install smoke test against every supported export.
Temporary package data is cleaned up.
The smoke test uses pnpm pack with lifecycle scripts disabled to reuse that build, then a normal
npm consumer install to verify the package does not require pnpm or build tools.
Standalone pnpm pack runs prepack once, so it cannot ship stale dist output.

Focused work should use node --test tests/<file>.test.ts; only repeat broad
validation after further changes or failures.

## Changes and compatibility

Find the closest implementation, harness and fixture first.
Reuse existing abstractions.
New
public APIs, dependencies, evidence semantics and broad restructuring need explicit design notes
and review. docs/architecture.md owns layer and API contracts; docs/design.md owns design decisions and compatibility
evidence.
Before a provider schema change, update its RESEARCH.md separating producer facts,
consumer compatibility observations and our decisions.
Preserve source revisions.

A bug fix starts with a focused failing reproduction.
Fix implementation after establishing the
failure, then run the regression and relevant tests.
Do not change architecture to avoid testing
or update goldens merely to hide failures.
Keep unrelated refactors separate.

## Generated evidence

Native JSONL/JSON, SQL and the fixture manifest are handwritten sources.
Databases are generated
from SQL; pnpm fixtures --regenerate is explicit.
Tests compare their logical rows against
an independent Node SQLite engine, so SQLite version-dependent file bytes are not treated as
semantic drift.
Node SQLite is a test/fixture producer only, never a production dependency.

pnpm goldens --update owns TypeScript snapshots.
Normal checks only compare them.
The 52 static v1 golden files remain untouched and are compared as semantic compatibility baselines.
The compressed Codex fixture must decompress to its JSONL source.
Existing sample provenance
and limitations are documented in fixtures/README.md.

## Policy and review

Type checking is strict and includes tests/tools.
It enables unchecked index and exact optional
property checks, unused locals/parameters and fallthrough detection.
Type-aware ESLint catches
unsafe assignments and unhandled promises; Node's test runner owns explicitly scheduled test
promises.
Hyoban owns formatting; there is no separate Prettier command.
Knip follows tsdown entry points and package
exports back to source; the only duplicate-export exception is the intentional sessions/AgentSession
alias in src/index.ts.
Other unused internal exports and dependencies fail validation.
Layer/import checks reject provider coupling, shared provider identities and production
writes/network/native imports.
Necessary exceptions require a narrowly scoped, explained change
to the owning policy.
Inline ESLint suppression and TypeScript bypass comments are prohibited.

Prefer a good library for general infrastructure.
Install it when it reduces long-term maintenance,
after checking correctness, pure-JS support, read-only/streaming behavior and license.
Do not build
another generic implementation to avoid a dependency.
Reuse existing packages and Node APIs when
they already meet the requirement. docs/design.md owns the runtime dependency decisions and
explains the narrow SQLite reader exception.

pnpm-lock.yaml is the only dependency lockfile.
The registry is fixed in pnpm-workspace.yaml, which configures this single package without adding
a monorepo.
All locked sources need registry integrity metadata; git/local sources fail validation.
Installed dependency licenses and install scripts are checked through pnpm's inventory and package
manifests; unknown licenses and unreviewed install scripts fail validation.
No dependency builds are approved.
CI installs with --frozen-lockfile --ignore-scripts.
Duplicate production dependency versions fail; development
plugins may need different compatible ranges and remain visible in the lockfile.
Development
licenses include the preset's documented data-package licenses; pnpm handles legacy license metadata.
New direct dependencies update tools/policy.ts with a
rationale.
This is a reviewed inventory, not a dependency-count limit.
Scheduled CI audits
production advisories separately from deterministic local checks.

CI checks Linux and macOS, including the minimum supported Node release line.
Configure the CI
job as a required branch-protection check on the hosting service; a workflow cannot enforce server
branch protection by itself.
There is no configured remote or publication in this checkout.

Review still decides whether a new native field is mapped correctly, whether a provider version
has enough evidence, whether public API adds value and whether a change duplicates architecture.
Executable checks cannot prove completeness for private future schemas or atomic live-store
reads.
Synthetic fixtures do not certify all product releases.
