# Architecture

**Agents propose. The database decides.** exactly-once is the commit layer for AI agent actions: a small, explicit protocol over PostgreSQL that turns probabilistic proposals into exactly-once commitments.

## Principles

1. **The database is the authority.** Not the prompt, not the schema, not application-level checks. Only constraints, transactions and row locks can guarantee.
2. **Mechanism here, policy in your domain.** The library owns the protocol (propose, hold, commit, receipt, audit). Your `validate` and `apply` callbacks own the business rules.
3. **Boring and explicit.** SQL with named constraints, no ORM magic, no dependency injection, no plugins. You can read the entire implementation in one sitting.
4. **Zero runtime dependencies.** Any PostgreSQL driver plugs in through a 20-line structural adapter.
5. **Typed where it matters.** Strict TypeScript; action callbacks are typed. Registry lookups use runtime action strings and are validated by the authority.

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
        expired          → mark 'expired' + event, commit, then E_HOLD_EXPIRED
        held + expired   → mark 'expired' + event, commit, then E_HOLD_EXPIRED
        held             → action.apply(ctx, payload) inside the transaction
                           ├── ActionRejected → row 'rejected' + reason
                           └── success       → row 'committed' + receipt (immutable)
```

Every mutation the domain needs happens inside the commit transaction. `apply` runs in a savepoint: on success its writes are kept; on any error its writes are rolled back. `ActionRejected` additionally records the rejection. For non-rejection errors the hold stays.

## Callback contract

`validate` must be logically read-only. It runs in a savepoint that is always rolled back, so persistent domain writes are discarded even when validation allows. Savepoints do not undo sequence advances, external effects or session-level side effects. This is a contract, not a security sandbox.

The payload passed to `validate` is a deep-frozen copy of the persisted JSON. Mutating it cannot change the decision or the payload `apply` will see; in strict mode the assignment throws.

`apply` is the only callback allowed to persist domain effects. It runs in a savepoint: on success its writes are kept; on `ActionRejected` its writes since the savepoint are rolled back and the rejection is recorded; on any other error the whole commit rolls back and the hold stays. External effects are not covered by either rollback.

## Guarantees and mechanisms

| Guarantee | Mechanism |
|---|---|
| No duplicated committed effect | `unique (scope, idempotency_key)` + immutable receipts; replays return the stored receipt |
| No hallucinated state | `validate` runs against live rows at propose time; `apply` must re-check the invariant at commit |
| Same-action concurrency | `SELECT ... FOR UPDATE` on the action row; different keys need domain constraints, conditional SQL or locks |
| Holds expire cleanly | TTL starts when `validate` approves; PostgreSQL `clock_timestamp()` is authoritative; `commit` materializes `expired` + event before throwing; `get` reports effective expiry without writing |
| Audit events | `cg_events` records state changes; append-only is an application convention, not database-enforced |
| Payload integrity | Same key + different action type or payload = `E_IDEMPOTENCY_MISMATCH` in every state, using PostgreSQL `jsonb` equality |

## Data model

- `cg_actions` — one row per logical action: scope, type, key, status, payload, decision, receipt, hold expiry.
- `cg_events` — event history per action. It is append-only by application convention; the schema does not enforce UPDATE/DELETE restrictions.
- Your domain tables stay yours. The only contract is that `validate`/`apply` receive a transaction client.

`scope` partitions idempotency keys (per tenant, per conversation, per anything). Keys are unique inside a scope. `commit(actionId)` also requires the action to belong to the authority's scope; an id from another scope is `E_NOT_FOUND`.

## Holds and time

- A new hold gets `expires_at = clock_timestamp() + ttl` only after `validate` approves it. A slow validation does not consume the TTL.
- TTL values must be finite and strictly positive, including the authority default. Invalid values fail at `createAuthority`.
- `commit` locks the action row, then evaluates expiry with PostgreSQL `clock_timestamp()`. If the hold is expired, it updates `expired`, inserts the `expired` event, commits, and only then throws `E_HOLD_EXPIRED`. Retries do not duplicate the event.
- `get` reports an effective `expired` status for a `held` row whose expiry has passed, without writing anything. `committed` and `rejected` rows are never rewritten by this rule.
- Revival is serialized with `commit` by the row lock. Whichever transaction acquires the lock first defines the order; neither path duplicates `expired` or `committed` events.

## Adapters

The `Database` interface is structural: two methods, zero imports. `fromPg` ships in the package and covers `pg` pools. Any other driver is a short adapter. The transaction client must support `SAVEPOINT`, `ROLLBACK TO SAVEPOINT` and `RELEASE SAVEPOINT`; the authority uses them around `validate` and `apply`. This is `postgres.js`:

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

### Connection failures and ambiguous COMMIT

`fromPg` attaches an `error` listener to the checked-out client, removes it before release, marks the connection broken when it fires, and calls `release(error)` so a broken client is destroyed instead of returning to the pool as healthy.

Errors before `COMMIT` roll back the transaction and are rethrown unchanged; PostgreSQL codes such as `40P01` and `40001` remain available to the consumer. If `COMMIT` itself fails with a transport error or a connection-class SQLSTATE, the outcome is unknown: `fromPg` throws `PgCommitUnknownError` with the original `cause` and SQLSTATE in `code` when available. Reconcile by calling `commit(actionId)` again or `propose` with the same idempotency key and payload. The adapter does not retry callbacks or external effects.

## Why not X

- **Prompt rules** ("never duplicate"): advisory. No guarantee.
- **Schema validation** (zod and friends): validates shape, not state. A taken slot is still valid JSON.
- **App-level checks**: race conditions under concurrency.
- **Database constraints alone**: stop the duplicate, but provide no proposal semantics, holds, receipts or audit.
- **Durable execution engines** (Temporal, Restate, DBOS): solve step replay at workflow level; heavier, and they still push idempotency to you. This library is the single-commit authority you can use with or without them.

## Exactly-once, precisely

Inside your database, commits are exactly-once: a repeated `commit` returns the same receipt and never runs the effect twice. `apply` itself may run more than once if an earlier transaction rolls back; the guarantee is at-most-once for the committed database effect, not for callback execution.

Payloads and results must be JSON-compatible. The authority validates them before use, rejects unstable JavaScript values, and stores a void `apply` result as `null`. The first commit returns the receipt persisted by PostgreSQL, so replay and `get` return the same representation.

If your `apply` calls an external service, pass its idempotency key along too (Stripe has one, for example). Durability here plus an idempotency key there is what makes retries safe end to end. That combination is usually called effectively-once, and it is the honest name for the whole chain. For messaging or multi-step external work, use an outbox/inbox or a durable workflow; neither is built into this library.

## Testing pyramid

| Layer | What it proves | Command |
|---|---|---|
| `test/unit` | Definitions, JSON contract, adapter behavior, input validation | `pnpm test` |
| `test/integration` | Lifecycle over real PostgreSQL: holds, expiry, revival, rejections, audit, quickstart, connection resilience | `pnpm test:db` |
| `test/concurrency` | 40 agents racing for one slot; 100 commits for one action | `pnpm test:db` |

PostgreSQL for tests comes from `docker-compose.yml` (host port 5433).

## Stack

TypeScript (strict) · tsdown (ESM + CJS + dts) · vitest · biome · PostgreSQL 15+ (CI: 15/16/17/18) · GitHub Actions with a real Postgres service.

## Roadmap

- v0.1: propose / commit / get, holds with TTL, revivals, receipts, audit, concurrency suite.
- v0.2: MCP server adapter (`exactly-once/mcp`) exposing the protocol as tools.
- v0.3 (current): contract corrections, expiry authority, PostgreSQL adapter resilience, stabilization and release packaging.
