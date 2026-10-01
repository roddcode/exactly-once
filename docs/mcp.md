# MCP server

`exactly-once/mcp` exposes the authority protocol as three MCP tools, so any MCP-compatible agent can propose, commit and inspect actions without writing glue code. The adapter lives behind a subpath: the core package keeps zero runtime dependencies.

## Install

```bash
npm install exactly-once pg @modelcontextprotocol/sdk zod
```

`@modelcontextprotocol/sdk` and `zod` are optional peer dependencies. Only the `exactly-once/mcp` subpath needs them.

## Usage

```ts
import { Pool } from "pg";
import { ActionRejected, createAuthority, defineAction, fromPg } from "exactly-once";
import { connectStdio, createMcpServer } from "exactly-once/mcp";

const createBooking = defineAction({
  type: "createBooking",
  hold: { ttlSeconds: 300 },
  validate: async (ctx, payload) => {
    const rows = await ctx.tx.query(
      "select 1 from slots where id = $1 and booking_id is null",
      [payload.slot],
    );
    return rows.length > 0 ? { allow: true } : { allow: false, reason: "slot_taken" };
  },
  apply: async (ctx, payload) => {
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

const server = createMcpServer({ authority });
await connectStdio(server);
```

## Tools

| Tool | Input | Returns |
|---|---|---|
| `propose_action` | `actionType`, `payload`, `idempotencyKey` | `{ status: "approved", actionId, expiresAt }`, `{ status: "rejected", reason, alternatives? }`, or `{ status: "committed", receipt }` on a replay |
| `commit_action` | `actionId` | `{ status: "committed", receipt }` or `{ status: "rejected", reason, alternatives? }` |
| `get_action` | `idempotencyKey` | The action record (status, hold expiry, reason, receipt) or `null`. Never executes anything. |

## Errors

Operational errors (`AuthorityError`) come back as tool errors: `isError: true` with `{ "error": { "code": "E_*", "message": "..." } }`. Domain rejections are not errors — they are normal results with `status: "rejected"` and optional `alternatives` the agent can offer instead.

## Agent flow

```
propose_action → approved  → commit_action → receipt
               → rejected  → offer alternatives, propose again
               → committed → replay: the same receipt, nothing runs twice
```

## Notes

- The server owns no state: everything lives in your PostgreSQL through the authority.
- `connectStdio` covers stdio (a client spawning the server as a child process). For any other transport, use `server.connect(transport)` with the server returned by `createMcpServer`.
- Server name, version and client instructions are configurable through `createMcpServer` options.
- New in 0.2.0. Feedback and issues welcome.
