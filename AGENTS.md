# Coding Agent instructions

Read README.md, docs/architecture.md and the nearest implementation, research file, tests and
fixtures before changing code.
Extend existing helpers and abstractions; do not create parallel
parsers or projections.
Compilation alone does not establish architectural fit.

Keep scope to local discovery, scanning, reading, normalization and evidence preservation.
The maintained implementation is TypeScript.
Use pnpm; package.json pins its version. tsdown owns dist JavaScript and declarations;
tsc is for type checking. pnpm-lock.yaml is the only dependency lockfile.
Keep the package free of native cores, cross-language bindings, WASM, sidecars, runtime control,
network ingestion, indexing and UI.

Prefer a good, maintained library for general infrastructure rather than implementing another
parser, codec or tooling framework.
Install the appropriate library when it improves maintenance;
reuse existing dependencies and Node APIs where they already fit.
Evaluate pure-JS compatibility,
read-only behavior, streaming limits, correctness, licenses and transitive installation cost.
Do not reject a useful dependency merely to keep the dependency count small.
A custom implementation
needs an explicit explanation of why suitable libraries cannot meet the required behavior.

New dependencies, public APIs, abstractions, serialized schema semantics, feature architecture and
large module moves are design decisions: describe the owner, alternatives and compatibility
impact explicitly.
Update the owning document and executable architecture checks together.

Provider format changes require a RESEARCH.md distinguishing official facts, third-party
compatibility experience and our decisions.
Reuse confirmed provider behavior and fixtures before external archaeology.
Keep provider imports independent; observe uses only public contracts.

Match changes to the issue.
Avoid unrelated refactors, lint suppressions, type-check bypasses,
ignored tests and blanket exceptions.
Preserve complete native records, unknown events, order,
repeated IDs and missing facts.
Never edit or repair agent stores.
Do not read current workspace
files to invent past state.
Use existing utilities, test helpers and fixture harnesses.

For a bug fix, add a focused reproduction to the nearest harness and establish that it fails
before changing implementation.
Then fix and rerun the focused regression.
Test difficulty is
not permission to restructure production architecture silently.

Do not hand-edit dist declarations, generated fixture databases or goldens.
Edit SQL/native
sources first. pnpm fixtures --regenerate owns DB generation; pnpm goldens --update
explicitly owns TypeScript snapshots.
Static v1 goldens remain immutable semantic compatibility baselines.
Review semantic diffs.

Run pnpm check before handing back work.
It runs Hyoban ESLint/formatting, strict type checking, Knip, layer/dependency policy,
fixtures, compatibility, streaming and the installed package.
Run focused tests while fixing
failures; do not repeatedly rebuild or run the full suite without new evidence.
Dist is small
and disposable.
Do not cache native artifacts.
Report any validation that could not run.

Write all repository Markdown in English.
Retain the Chinese brand only in the project name.
