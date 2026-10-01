# Architecture

**Agents propose. The database decides.** exactly-once is the commit layer for AI agent actions: a small, explicit protocol over PostgreSQL that turns probabilistic proposals into exactly-once commitments.

## Principles

1. **The database is the authority.** Not the prompt, not the schema, not application-level checks. Only constraints, transactions and row locks can guarantee.
2. **Mechanism here, policy in your domain.** The library owns the protocol (propose, hold, commit, receipt, audit). Your `validate` and `apply` callbacks own the business rules.
3. **Boring and explicit.** SQL with named constraints, no ORM magic, no dependency injection, no plugins. You can read the entire implementation in one sitting.
4. **Zero runtime dependencies.** Any PostgreSQL driver plugs in through a 20-line structural adapter.
5. **Typed end to end.** Strict TypeScript, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.

## The protocol

```
propose(type, payload, { idempotencyKey })
    │
    ├── INSERT ... ON CONFLICT DO NOTHING      (idempotency gate)
    │
    ├── new key  → row status 'held' + TTL
    │              validate(ctx, payload) against live state
    │                 ├── allow  → { approved, actionId, expiresAt }
    │                 └── reject → row 'rejected' + reason + alternatives
    │
    └── known key → read row FOR UPDATE
                   ├── committed            → { committed, receipt }   (replay)
                   ├── held and not expired → { approved, actionId }    (same hold)
                   └── expired/rejected     → revive (payload must match, else E_IDEMPOTENCY_MISMATCH)

commit(actionId)
    │
    └── transaction
        SELECT ... FOR UPDATE on the action row      (serializes commits)
        status committed → return stored receipt      (exactly-once)
        status rejected  → E_NOT_HELD
        expired          → mark 'expired', E_HOLD_EXPIRED
        held             → action.apply(ctx, payload) inside the transaction
                           ├── ActionRejected → row 'rejected' + reason
                           └── success       → row 'committed' + receipt (immutable)
```

Every mutation the domain needs happens inside the commit transaction: if `apply` throws, everything rolls back and the hold is still there.

## Guarantees and mechanisms

| Guarantee | Mechanism |
|---|---|
| No duplicated actions | `unique (scope, idempotency_key)` + immutable receipts; replays return the stored receipt |
| No hallucinated state | `validate` runs against live rows inside the proposal transaction |
| Safe under concurrency | `SELECT ... FOR UPDATE` on the action row; domain rows locked inside the same transaction |
| Holds expire cleanly | `expires_at` + TTL; expired holds are never committed, only revived with the same payload |
| Full audit trail | `cg_events` is append-only (`held`, `rejected`, `revived`, `expired`, `committed`) |
| Payload integrity | Same key + different payload = `E_IDEMPOTENCY_MISMATCH` (canonical JSON comparison) |

## Data model

- `cg_actions` — one row per logical action: scope, type, key, status, payload, decision, receipt, hold expiry.
- `cg_events` — append-only history per action.
- Your domain tables stay yours. The only contract is that `validate`/`apply` receive a transaction client.

`scope` partitions idempotency keys (per tenant, per conversation, per anything). Keys are unique inside a scope.

## Adapters

The `Database` interface is structural: two methods, zero imports. `fromPg` ships in the package and covers `pg` pools. Any other driver is a short adapter. This is `postgres.js`:

```ts
import postgres from "postgres";
import type { Client, Database } from "exactly-once";

function client(tx: postgres.TransactionSql): Client {
  return {
    async query<R = Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      return (await tx.unsafe(text, params as unknown[])) as R[];
    },
  };
}

export function fromPostgresJs(sql: postgres.Sql): Database {
  return {
    async query<R = Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      return (await sql.unsafe(text, params as unknown[])) as R[];
    },
    async transaction<T>(fn: (tx: Client) => Promise<T>): Promise<T> {
      return sql.begin(async (tx) => fn(client(tx)));
    },
  };
}
```

Drivers that only speak tagged templates still work: adapt their raw-query path to `unsafe`-style calls with parameters bound at the protocol level.

## Why not X

- **Prompt rules** ("never duplicate"): advisory. No guarantee.
- **Schema validation** (zod and friends): validates shape, not state. A taken slot is still valid JSON.
- **App-level checks**: race conditions under concurrency.
- **Database constraints alone**: stop the duplicate, but provide no proposal semantics, holds, receipts or audit.
- **Durable execution engines** (Temporal, Restate, DBOS): solve step replay at workflow level; heavier, and they still push idempotency to you. This library is the single-commit authority you can use with or without them.

## Exactly-once, precisely

Inside your database, commits are exactly-once: a repeated `commit` returns the same receipt and never runs the effect twice.

If your `apply` calls an external service, pass its idempotency key along too (Stripe has one, for example). Durability here plus an idempotency key there is what makes retries safe end to end. That combination is usually called effectively-once, and it is the honest name for the whole chain.

## Testing pyramid

| Layer | What it proves | Command |
|---|---|---|
| `test/unit` | Definitions, registry, input validation | `pnpm test` |
| `test/integration` | Lifecycle over real PostgreSQL: holds, expiry, revival, rejections, audit | `pnpm test:db` |
| `test/concurrency` | 40 agents, one slot: exactly one commit; same-key storm: one hold | `pnpm test:db` |

PostgreSQL for tests comes from `docker-compose.yml` (host port 5433).

## Stack

TypeScript (strict) · tsdown (ESM + CJS + dts) · vitest · biome · PostgreSQL 13+ · CI on GitHub Actions with a real Postgres service.

## Roadmap

- v0.1: propose / commit / get, holds with TTL, revivals, receipts, audit, concurrency suite.
- v0.2 (current): MCP server adapter (`exactly-once/mcp`) exposing the protocol as tools.
- v0.3: clinic-booking example app, first-party Drizzle and postgres.js adapters, CLI (`init`, `migrate`, `status`), lifecycle hooks.
