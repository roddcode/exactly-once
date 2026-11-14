# Changelog

## Unreleased

### Changed

- MCP tool descriptions now state the actual guarantee: at most one committed PostgreSQL effect per action, with receipt replay. `propose_action` no longer advertises unconditional idempotency; rejected or expired proposals can be revalidated.

### Fixed

- `validate` now receives a deep-frozen copy of the persisted payload. A mutating callback can no longer approve values that `apply` will not see.

### Added

- `examples/mcp-retry`: a runnable MCP client and server that commit twice over separate connections and verify one domain row, one committed action, and one persisted receipt.

## 0.3.0 — 2026-11-13

### Breaking

- Require Node 22.13+ (Node 20 is EOL) and PostgreSQL 15+; CI covers Node 22/24 and PostgreSQL 15/16/17/18.
- Enforce JSON-compatible payloads and `apply` results. Unsupported values now fail with `E_INVALID_PAYLOAD` or `E_INVALID_RESULT`; a void result is stored as `null`.
- Bind idempotency identity to `(scope, key, actionType, payload)` in every state, including `committed`.
- Scope `commit(actionId)` to the authority's scope; cross-scope ids return `E_NOT_FOUND`.
- Start hold TTL after `validate` approves and use PostgreSQL `clock_timestamp()` for expiry decisions.
- Persist `expired` and its event before `E_HOLD_EXPIRED`; `get` reports effective expiry without writing.
- Require the MCP adapter peers `@modelcontextprotocol/sdk` 1.32+ and Zod 4.6.6+ when using `exactly-once/mcp`.

### Fixed

- `ActionRejected` and `validate` deny no longer leave domain writes committed.
- Commits and revivals no longer execute a different action type or payload than the one identified by the key.
- Revivals and commits are serialized without duplicate `expired`/`committed` events.
- `fromPg` survives client connection errors, discards broken clients, and exposes `PgCommitUnknownError` for ambiguous `COMMIT` outcomes.
- Added quickstart, scope-isolation, expiry, adapter-resilience and same-action commit-storm regressions.

### Packaging

- Publish `docs/` and this changelog in the npm tarball.
- Add the MCP stdio smoke test to CI.
- The MCP server announces version `0.3.0`.
