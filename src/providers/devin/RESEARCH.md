# Devin CLI compatibility evidence

Reviewed upstream source and documentation on 2026-10-05.

## Official facts

- [Source](https://docs.devin.ai/work-with-devin/devin-cli): The official CLI documentation describes local sessions and resume behavior.
  It does not define a stable public SQLite schema.

## Third-party compatibility experience

[Independent connector evidence](https://github.com/Dicklesworthstone/franken_agent_detection/blob/main/src/connectors/devin.rs) documents ~/.local/share/devin/cli/sessions.db, sessions.main_chain_id and message_nodes parent edges. created_at and last_activity_at are epoch seconds; chat_message retains OpenAI-style tool_calls and tool_call_id.
This is empirical private-store evidence, not an official contract.

## Huihua decisions

Discover the absolute XDG_DATA_HOME location or ~/.local/share/devin/cli/sessions.db.
Require locator.id for a database read.
Preserve the selected session row and every selected message node, including hidden sessions and abandoned branches.
Emit main-chain nodes in native parent order, followed by remaining nodes in database row order; expose node/parent and on_main_chain metadata instead of interleaving branches into a reconstructed current transcript.
Tool diagnostics use native branch scopes so results on abandoned branches cannot satisfy main-chain calls with reused IDs.
Cycles, missing parents and repeated node IDs are diagnosed; no native nodes are removed.
Keep JSON column strings and complete rows.
Do not treat zero cost placeholders or context cursors as usage.
Cloud sessions are outside local coverage.

Fixtures combine local synthetic examples and pinned independent compatibility inputs; they do not establish release-wide correctness.
[Fixture provenance](../../../fixtures/compatibility/README.md) distinguishes upstream validation from the facts asserted through Huihua's public API.
[Architecture](../../../docs/architecture.md#provider-coverage-and-format-ownership) owns acquisition, evidence and resource-limit contracts.
