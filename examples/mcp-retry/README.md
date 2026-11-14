# MCP retry example

This example proves the guarantee end to end with a real MCP client and server:

1. `propose_action` approves a booking and returns a hold.
2. `commit_action` writes the booking and its receipt in one transaction.
3. The client closes the connection, simulating a lost response.
4. A new connection retries `commit_action` with the same `actionId`.
5. The retry returns the identical receipt.
6. The example queries PostgreSQL directly and asserts one domain row, one
   committed action, and one `committed` event.

The second commit is a real MCP tool call; the SQL checks exist only to verify
the result, not to replace the protocol.

## Requirements

- Node 22.13+
- PostgreSQL 15+
- `pnpm install`
- `pnpm build` (the example imports the built `exactly-once` subpaths)

## Run

From the repository root:

```bash
pnpm db:up
pnpm build
pnpm example:mcp-retry
```

The default connection string is
`postgres://exactly_once:exactly_once@localhost:5433/exactly_once`, which matches
`docker-compose.yml`. Override it with `DATABASE_URL` or `TEST_DATABASE_URL`.

Expected output:

```text
1. propose_action
   approved: actionId=...
2. commit_action
   committed: committedAt=...
3. simulate lost response: reconnect and retry commit_action
   replay returned the identical receipt
4. get_action
   status=committed
5. verify PostgreSQL state
   demo_slots rows=1 committed_actions=1 committed_events=1

PASS: two commit attempts, one domain row, one receipt.
```

## What this does and does not prove

It proves that a committed action has at most one PostgreSQL effect and that
retries replay the persisted receipt. It does not prove that `apply` runs only
once: PostgreSQL may roll back a transaction and the callback may run again.
External side effects need their own idempotency key or an outbox. See
[`docs/architecture.md`](../../docs/architecture.md#exactly-once-precisely).
