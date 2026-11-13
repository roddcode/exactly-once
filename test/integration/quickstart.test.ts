import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionRejected, type Authority, createAuthority, defineAction } from "../../src/index.js";
import { openTestDatabase, type TestDb } from "../helpers/db.js";

const createBooking = defineAction<{ slot: string }, { slot: string }>({
  type: "createBooking",
  hold: { ttlSeconds: 300 },
  validate: async (ctx, payload) => {
    const rows = await ctx.tx.query(
      "select 1 from quickstart_slots where id = $1 and booking_id is null",
      [payload.slot],
    );
    return rows.length > 0 ? { allow: true } : { allow: false, reason: "slot_taken" };
  },
  apply: async (ctx, payload) => {
    const updated = await ctx.tx.query(
      "update quickstart_slots set booking_id = $1 where id = $2 and booking_id is null returning id",
      [ctx.idempotencyKey, payload.slot],
    );
    if (updated.length === 0) {
      throw new ActionRejected("slot_taken");
    }
    return { slot: payload.slot };
  },
});

describe("README quickstart flow", () => {
  let database: TestDb;
  let authority: Authority;

  beforeAll(async () => {
    database = await openTestDatabase();
    await database.db.query(
      "create table if not exists quickstart_slots (id text primary key, booking_id text)",
    );
    authority = createAuthority({
      db: database.db,
      scope: "quickstart",
      actions: [createBooking],
    });
    await authority.migrate();
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await database.reset(["quickstart"]);
    await database.db.query("truncate table quickstart_slots");
    await database.db.query("insert into quickstart_slots (id) values ('sat-1500')");
  });

  it("creates a hold, commits once, and replays the receipt", async () => {
    const proposal = await authority.propose(
      "createBooking",
      { slot: "sat-1500" },
      { idempotencyKey: "wa-msg-8821" },
    );
    if (proposal.status !== "approved") throw new Error("expected approved");

    const result = await authority.commit(proposal.actionId);
    if (result.status !== "committed") throw new Error("expected committed");
    expect(result.receipt.result).toEqual({ slot: "sat-1500" });

    const replay = await authority.commit(proposal.actionId);
    expect(replay).toEqual(result);
    expect((await authority.get("wa-msg-8821"))?.status).toBe("committed");
  });

  it("returns a domain rejection when the slot is taken", async () => {
    const first = await authority.propose(
      "createBooking",
      { slot: "sat-1500" },
      { idempotencyKey: "first" },
    );
    if (first.status !== "approved") throw new Error("expected approved");
    await authority.commit(first.actionId);

    const second = await authority.propose(
      "createBooking",
      { slot: "sat-1500" },
      { idempotencyKey: "second" },
    );
    expect(second.status).toBe("rejected");
    if (second.status !== "rejected") throw new Error("expected rejected");
    expect(second.reason).toBe("slot_taken");
  });
});
