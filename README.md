# exactly-once

**Agents propose. The database decides.**

Exactly-once, domain-checked commits for AI agent actions. Your agent can retry as much as it wants: the action happens once, or not at all.

> Status: `v0.1.0` published. The core protocol (propose / commit / get over PostgreSQL) is implemented and tested against a real database, including a 40-agent concurrency race. npm `0.0.1` was a name reservation.

## The problem

AI agents retry. A timeout, a crash, an ambiguous response: every one of them leads to the same move, calling the tool again. When that tool books an appointment or charges a card, the retry duplicates a real-world action.

The usual fixes don't hold. Prompts are advice the model can ignore; schemas check the shape of a payload without knowing whether the slot is still free; application-level checks race the moment two requests arrive together. Only the database can guarantee this, so that is where the decision lives.

## How it works

```
propose → validate against live state → hold → commit (one transaction) → receipt
```

Three verbs: `propose`, `commit`, `get`.

## Quickstart

```bash
docker compose up -d --wait   # local Postgres on :5433
pnpm install
pnpm test:db                  # integration + concurrency suites
```

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
- **The database decides**: domain validation against live state, inside the transaction.
- **Safe under concurrency**: 40 agents racing for one slot produce exactly one commit (see `test/concurrency`).
- **Holds with TTL**: expired holds are never committed; reviving requires the same payload.
- **Audit trail**: every proposal, rejection and commit lands in an append-only log you can query.

## A note on the name

The name claims something precise, so it's worth being precise back. Inside your database, commits are exactly-once: a repeated `commit` returns the same receipt and never runs the effect twice.

If your `apply` calls an external service, pass its idempotency key along too (Stripe has one, for example). Durability on this side plus an idempotency key on the other is what makes retries safe end to end. That combination is usually called effectively-once, and it's the honest name for the whole chain.

## What this is not

This is not an agent framework, a workflow engine or a SaaS. It doesn't replace any of those, and it doesn't care which one you use. It sits between your agent and your database and owns exactly one decision: whether an action commits, and how many times.

## Docs

- [`docs/architecture.md`](docs/architecture.md): protocol, guarantees, data model, why not X.

## Development

| Command | What it does |
|---|---|
| `pnpm db:up` | Start PostgreSQL (docker compose, port 5433) |
| `pnpm test` | Unit tests (no database) |
| `pnpm test:db` | Integration + concurrency suites (run `pnpm db:up` first) |
| `pnpm typecheck` | Strict TypeScript |
| `pnpm lint` | Biome |
| `pnpm build` | tsdown (ESM + CJS + d.ts) |
| `pnpm validate:package` | publint + are-the-types-wrong |

## License

MIT
