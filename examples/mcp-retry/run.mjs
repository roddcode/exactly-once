import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fromPg, migrate } from "exactly-once";
import pg from "pg";
import { DATABASE_URL, IDEMPOTENCY_KEY, resetExample, SCOPE, SLOT } from "./authority.mjs";

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "server.mjs")],
    env: { ...process.env, DATABASE_URL },
    stderr: "inherit",
  });
  const client = new Client({ name: "mcp-retry-example", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  return JSON.parse(text);
}

const pool = new Pool({ connectionString: DATABASE_URL });
let firstClient;
let replayClient;

try {
  await pool.query("create table if not exists demo_slots (id text primary key, booking_id text)");
  // Idempotent: the server runs migrations too, but resetting first makes
  // repeated example runs deterministic.
  await migrate(fromPg(pool));
  await resetExample(pool);

  console.log("1. propose_action");
  firstClient = await connect();
  const proposal = await call(firstClient, "propose_action", {
    actionType: "createBooking",
    payload: { slot: SLOT },
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.equal(proposal.status, "approved");
  console.log(`   approved: actionId=${proposal.actionId}`);

  console.log("2. commit_action");
  const first = await call(firstClient, "commit_action", {
    actionId: proposal.actionId,
  });
  assert.equal(first.status, "committed");
  console.log(`   committed: committedAt=${first.receipt.committedAt}`);

  // Simulate a client that never observed the commit response. The connection
  // is gone, so it reconnects and retries the same action id.
  await firstClient.close();
  firstClient = undefined;

  console.log("3. simulate lost response: reconnect and retry commit_action");
  replayClient = await connect();
  const replay = await call(replayClient, "commit_action", {
    actionId: proposal.actionId,
  });
  assert.deepEqual(replay, first);
  console.log("   replay returned the identical receipt");

  console.log("4. get_action");
  const record = await call(replayClient, "get_action", {
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.equal(record.status, "committed");
  assert.deepEqual(record.receipt, first.receipt);
  console.log(`   status=${record.status}`);

  console.log("5. verify PostgreSQL state");
  const { rows: slots } = await pool.query(
    "select count(*)::int as n from demo_slots where booking_id = $1",
    [IDEMPOTENCY_KEY],
  );
  const { rows: actions } = await pool.query(
    "select count(*)::int as n from cg_actions where scope = $1 and idempotency_key = $2 and status = 'committed' and receipt is not null",
    [SCOPE, IDEMPOTENCY_KEY],
  );
  const { rows: commits } = await pool.query(
    "select count(*)::int as n from cg_events e join cg_actions a on a.id = e.action_id where a.scope = $1 and a.idempotency_key = $2 and e.event = 'committed'",
    [SCOPE, IDEMPOTENCY_KEY],
  );
  assert.equal(slots[0].n, 1);
  assert.equal(actions[0].n, 1);
  assert.equal(commits[0].n, 1);
  console.log(
    `   demo_slots rows=${slots[0].n} committed_actions=${actions[0].n} committed_events=${commits[0].n}`,
  );

  console.log("\nPASS: two commit attempts, one domain row, one receipt.");
} finally {
  await firstClient?.close().catch(() => {});
  await replayClient?.close().catch(() => {});
  await pool.end();
}
