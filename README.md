# exactly-once

**Agents propose. The database decides.**

[![npm version](https://img.shields.io/npm/v/exactly-once.svg)](https://www.npmjs.com/package/exactly-once)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Exactly-once PostgreSQL commits for AI agent actions. Agents propose, the database decides, and retries replay the persisted receipt instead of running the effect twice.

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

Requires Node 22.13+ and PostgreSQL 14+ (CI covers PostgreSQL 14/16/17).

Create the domain table before running the example. The authority only owns its own `cg_*` tables; your domain stays yours.

```sql
create table if not exists slots (id text primary key, booking_id text);
insert into slots (id) values ('sat-1500');
```

```ts
import { Pool } from "pg";
import { ActionRejected, createAuthority, defineAction, fromPg } from "exactly-once";

const createBooking = defineAction<{ slot: string }, { slot: string }>({
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
    // Runs inside the commit transaction. The conditional update is the atomic
    // re-check: if another action took the slot after our hold, zero rows
    // update, and we reject instead of double-booking.
    const updated = await ctx.tx.query(
      "update slots set booking_id = $1 where id = $2 and booking_id is null returning id",
      [ctx.idempotencyKey, payload.slot],
    );
    if (updated.length === 0) {
      throw new ActionRejected("slot_taken");
    }
    return { slot: payload.slot };
  },
});

const authority = createAuthority({
  db: fromPg(new Pool({ connectionString: process.env.DATABASE_URL })),
  actions: [createBooking],
});
await authority.migrate();

const proposal = await authority.propose(
  "createBooking",
  { slot: "sat-1500" },
  { idempotencyKey: "wa-msg-8821" },
);

if (proposal.status === "approved") {
  const result = await authority.commit(proposal.actionId);
  console.log(result);
  // Replaying `commit` returns the same receipt. Always.
}
```

`validate` is logically read-only; `apply` is the only callback allowed to persist domain writes, and it must re-check the invariant it needs at commit time. A hold is an approved intention, not a reservation.

The guarantee covers PostgreSQL effects. If `apply` calls an external service, give that service a stable idempotency key or publish through an outbox; see [exactly-once, precisely](docs/architecture.md#exactly-once-precisely).

## MCP server

Any MCP-compatible agent can call the protocol as tools. The adapter lives behind the `exactly-once/mcp` subpath, so the core package stays zero-dependency.

```bash
npm install exactly-once pg @modelcontextprotocol/sdk zod
```

```ts
import { Pool } from "pg";
import { createAuthority, defineAction, fromPg } from "exactly-once";
import { connectStdio, createMcpServer } from "exactly-once/mcp";

const authority = createAuthority({
  db: fromPg(new Pool({ connectionString: process.env.DATABASE_URL })),
  actions: [createBooking],
});
await authority.migrate();

const server = createMcpServer({ authority });
await connectStdio(server);
```

Three tools: `propose_action`, `commit_action` and `get_action`. Rejections flow back with reasons and alternatives; operational errors return `isError` with the `E_*` code. Details: [`docs/mcp.md`](docs/mcp.md).

The adapter is not an authorization boundary. Authenticate clients in the host and gate `commit_action` with the approval policy your application requires.

## Guarantees

- **Exactly-once database effect per identity**: `(scope, key, actionType, payload)` has one committed outcome; replays return the persisted receipt.
- **Domain-checked**: `validate` runs against live state at propose time; `apply` re-checks the domain invariant inside the commit transaction.
- **Same-action concurrency**: a row lock serializes commits for the same action. Different keys on the same resource need conditional SQL, constraints or locks in your domain.
- **Holds with TTL**: expired holds are never committed; `get` reports effective expiry, and reviving requires the same payload.
- **Audit events**: state changes land in `cg_events`; append-only is an application convention, not database-enforced.
- **PostgreSQL-local**: external effects are outside the transaction. Use provider idempotency keys, an outbox or a durable workflow for those.

## Docs

- [`docs/architecture.md`](docs/architecture.md): protocol, guarantees, data model, adapters, why not X.
- [`docs/errors.md`](docs/errors.md): error codes and how to handle each one.
- [`docs/mcp.md`](docs/mcp.md): MCP server — tools, errors, agent flow.

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
| `pnpm smoke:mcp` | Exercise the built `exactly-once/mcp` subpath |
| `pnpm validate:package` | publint + are-the-types-wrong |

## License

MIT

---

Built by [roddcode](https://roddcode.com) — I build AI systems that don't fail when money is at stake. [Hablemos 30 minutos](https://roddcode.com) · [LinkedIn](https://linkedin.com/in/alejandro-alvarado-roddcode)
