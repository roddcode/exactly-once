# exactly-once

**Agents propose. The database decides.**

[![npm version](https://img.shields.io/npm/v/exactly-once.svg)](https://www.npmjs.com/package/exactly-once)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Exactly-once, domain-checked commits for AI agent actions. Your agent can retry as much as it wants: the action happens once, or not at all.

## The problem

AI agents retry. A timeout, a crash, an ambiguous response: every one of them leads to the same move, calling the tool again. When that tool books an appointment or charges a card, the retry duplicates a real-world action. Application-level checks race the moment two requests arrive together, so the guarantee has to live in the database.

## How it works

```
propose → validate against live state → hold → commit (one transaction) → receipt
```

Three verbs: `propose`, `commit`, `get`.

## Quickstart

```bash
npm install exactly-once pg
```

Requires Node 20.19+ and PostgreSQL 13+.

The example assumes a `slots(id, booking_id)` table in your database. The authority only owns its own `cg_*` tables; your domain stays yours.

```ts
import { Pool } from "pg";
import { createAuthority, defineAction, fromPg } from "exactly-once";

const createBooking = defineAction({
  type: "createBooking",
  hold: { ttlSeconds: 300 },
  validate: async (ctx, payload) => {
    const rows = await ctx.tx.query(
      "select 1 from slots where id = $1 and booking_id is null",
      [payload.slot],
    );
    return rows.length > 0
      ? { allow: true }
      : { allow: false, reason: "slot_taken" };
  },
  apply: async (ctx, payload) => {
    // Runs inside the commit transaction. If it throws, nothing commits.
    await ctx.tx.query("update slots set booking_id = $1 where id = $2", [
      ctx.idempotencyKey,
      payload.slot,
    ]);
    return { slot: payload.slot };
  },
});

const authority = createAuthority({
  db: fromPg(new Pool({ connectionString: process.env.DATABASE_URL })),
  actions: [createBooking],
});

const proposal = await authority.propose(
  "createBooking",
  { slot: "sat-1500" },
  { idempotencyKey: "wa-msg-8821" },
);

if (proposal.status === "approved") {
  const result = await authority.commit(proposal.actionId);
  // Replaying `commit` returns the same receipt. Always.
}
```

## Guarantees

- **Exactly-once**: unique idempotency keys and immutable receipts; replays return the stored receipt.
- **Domain-checked**: `validate` runs against live state inside the transaction, before anything commits.
- **Safe under concurrency**: 40 agents racing for one slot produce exactly one commit (see `test/concurrency`).
- **Holds with TTL**: expired holds are never committed; reviving requires the same payload.
- **Audit trail**: every proposal, rejection and commit lands in an append-only log you can query.

## Docs

- [`docs/architecture.md`](docs/architecture.md): protocol, guarantees, data model, adapters, why not X.
- [`docs/errors.md`](docs/errors.md): error codes and how to handle each one.

## Development

| Command | What it does |
|---|---|
| `pnpm db:up` | Start PostgreSQL (docker compose, port 5433) |
| `pnpm test` | Unit tests (no database) |
| `pnpm test:db` | Full suite against a real PostgreSQL (run `pnpm db:up` first) |
| `pnpm test:coverage` | Full suite with a coverage report |
| `pnpm typecheck` | Strict TypeScript |
| `pnpm lint` | Biome |
| `pnpm build` | tsdown (ESM + CJS + d.ts) |
| `pnpm validate:package` | publint + are-the-types-wrong |

## License

MIT
