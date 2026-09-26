import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionRejected, type Authority, createAuthority, defineAction } from "../../src/index.js";
import { openTestDatabase, type TestDb } from "../helpers/db.js";

interface BookingPayload {
  readonly slot: string;
  readonly customer: string;
}

const createBooking = defineAction<BookingPayload, { bookingId: string }>({
  type: "createBooking",
  hold: { ttlSeconds: 60 },
  validate: async (ctx, payload) => {
    const rows = await ctx.tx.query<{ id: string }>(
      "select id from integration_slots where id = $1 and booking_key is null",
      [payload.slot],
    );
    return rows.length > 0
      ? { allow: true }
      : { allow: false, reason: "slot_taken", alternatives: [{ slot: "sun-1000" }] };
  },
  apply: async (ctx, payload) => {
    const updated = await ctx.tx.query<{ id: string }>(
      "update integration_slots set booking_key = $1 where id = $2 and booking_key is null returning id",
      [ctx.idempotencyKey, payload.slot],
    );
    if (updated.length === 0) {
      throw new ActionRejected("slot_taken");
    }
    return { bookingId: `${payload.slot}:${payload.customer}` };
  },
});

async function expireHold(database: TestDb, idempotencyKey: string): Promise<void> {
  await database.db.query(
    "update cg_actions set expires_at = now() - interval '1 minute' where scope = 'it' and idempotency_key = $1",
    [idempotencyKey],
  );
}

describe("propose / commit / get", () => {
  let database: TestDb;
  let authority: Authority;

  beforeAll(async () => {
    database = await openTestDatabase();
    await database.db.query(
      "create table if not exists integration_slots (id text primary key, booking_key text)",
    );
    authority = createAuthority({ db: database.db, scope: "it", actions: [createBooking] });
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await database.reset(["it"]);
    await database.db.query("truncate table integration_slots");
    await database.db.query("insert into integration_slots (id) values ('sat-1500'), ('sun-1000')");
  });

  it("proposes a hold, commits exactly once, and replays the same receipt", async () => {
    const proposed = await authority.propose(
      "createBooking",
      { slot: "sat-1500", customer: "ana" },
      { idempotencyKey: "wa-1" },
    );
    if (proposed.status !== "approved")
      throw new Error(`expected approved, got ${proposed.status}`);

    const committed = await authority.commit(proposed.actionId);
    if (committed.status !== "committed") throw new Error("expected committed");

    const replay = await authority.commit(proposed.actionId);
    expect(replay).toEqual(committed);

    const record = await authority.get("wa-1");
    expect(record?.status).toBe("committed");
    expect(record?.receipt?.result).toEqual({ bookingId: "sat-1500:ana" });
  });

  it("records the audit trail", async () => {
    const proposed = await authority.propose(
      "createBooking",
      { slot: "sat-1500", customer: "ana" },
      { idempotencyKey: "wa-events" },
    );
    if (proposed.status !== "approved") throw new Error("expected approved");
    await authority.commit(proposed.actionId);

    const events = await database.db.query<{ event: string }>(
      "select event from cg_events where action_id = $1 order by id",
      [proposed.actionId],
    );
    expect(events.map((row) => row.event)).toEqual(["held", "committed"]);
  });

  it("replying a committed proposal with the same key returns the receipt", async () => {
    const first = await authority.propose(
      "createBooking",
      { slot: "sat-1500", customer: "ana" },
      { idempotencyKey: "wa-2" },
    );
    if (first.status !== "approved") throw new Error("expected approved");
    await authority.commit(first.actionId);

    const second = await authority.propose(
      "createBooking",
      { slot: "sat-1500", customer: "ana" },
      { idempotencyKey: "wa-2" },
    );
    expect(second.status).toBe("committed");
    if (second.status !== "committed") throw new Error("unreachable");
    expect(second.receipt.actionId).toBe(first.actionId);
  });

  it("rejects a different payload on a live key", async () => {
    await authority.propose(
      "createBooking",
      { slot: "sat-1500", customer: "ana" },
      { idempotencyKey: "wa-3" },
    );

    await expect(
      authority.propose(
        "createBooking",
        { slot: "sun-1000", customer: "luis" },
        { idempotencyKey: "wa-3" },
      ),
    ).rejects.toMatchObject({ code: "E_IDEMPOTENCY_MISMATCH" });
  });

  it("revives an expired hold when the payload matches", async () => {
    const first = await authority.propose(
      "createBooking",
      { slot: "sat-1500", customer: "ana" },
      { idempotencyKey: "wa-4" },
    );
    if (first.status !== "approved") throw new Error("expected approved");
    await expireHold(database, "wa-4");

    const revived = await authority.propose(
      "createBooking",
      { slot: "sat-1500", customer: "ana" },
      { idempotencyKey: "wa-4" },
    );
    expect(revived.status).toBe("approved");
    if (revived.status !== "approved") throw new Error("unreachable");
    expect(revived.actionId).toBe(first.actionId);
  });

  it("does not revive with a different payload", async () => {
    await authority.propose(
      "createBooking",
      { slot: "sat-1500", customer: "ana" },
      { idempotencyKey: "wa-5" },
    );
    await expireHold(database, "wa-5");

    await expect(
      authority.propose(
        "createBooking",
        { slot: "sun-1000", customer: "ana" },
        { idempotencyKey: "wa-5" },
      ),
    ).rejects.toMatchObject({ code: "E_IDEMPOTENCY_MISMATCH" });
  });

  it("returns rejected with alternatives from validate", async () => {
    const first = await authority.propose(
      "createBooking",
      { slot: "sat-1500", customer: "ana" },
      { idempotencyKey: "wa-6a" },
    );
    if (first.status !== "approved") throw new Error("expected approved");
    await authority.commit(first.actionId);

    const second = await authority.propose(
      "createBooking",
      { slot: "sat-1500", customer: "luis" },
      { idempotencyKey: "wa-6b" },
    );
    expect(second.status).toBe("rejected");
    if (second.status !== "rejected") throw new Error("unreachable");
    expect(second.reason).toBe("slot_taken");
    expect(second.alternatives).toEqual([{ slot: "sun-1000" }]);
  });

  it("rejects at commit when apply throws ActionRejected", async () => {
    const proposed = await authority.propose(
      "createBooking",
      { slot: "sun-1000", customer: "ana" },
      { idempotencyKey: "wa-7" },
    );
    if (proposed.status !== "approved") throw new Error("expected approved");

    // Someone else takes the slot after the hold was approved.
    await database.db.query(
      "update integration_slots set booking_key = 'someone-else' where id = 'sun-1000'",
    );

    const committed = await authority.commit(proposed.actionId);
    expect(committed.status).toBe("rejected");
    if (committed.status !== "rejected") throw new Error("unreachable");
    expect(committed.reason).toBe("slot_taken");

    const record = await authority.get("wa-7");
    expect(record?.status).toBe("rejected");
  });

  it("throws E_HOLD_EXPIRED when committing after expiry", async () => {
    const proposed = await authority.propose(
      "createBooking",
      { slot: "sat-1500", customer: "ana" },
      { idempotencyKey: "wa-8" },
    );
    if (proposed.status !== "approved") throw new Error("expected approved");
    await expireHold(database, "wa-8");

    await expect(authority.commit(proposed.actionId)).rejects.toMatchObject({
      code: "E_HOLD_EXPIRED",
    });
  });

  it("throws E_NOT_HELD when committing a rejected action", async () => {
    const first = await authority.propose(
      "createBooking",
      { slot: "sat-1500", customer: "ana" },
      { idempotencyKey: "wa-9a" },
    );
    if (first.status !== "approved") throw new Error("expected approved");
    await authority.commit(first.actionId);
    await authority.propose(
      "createBooking",
      { slot: "sat-1500", customer: "luis" },
      { idempotencyKey: "wa-9b" },
    );
    const record = await authority.get("wa-9b");
    if (!record) throw new Error("expected record");

    await expect(authority.commit(record.id)).rejects.toMatchObject({ code: "E_NOT_HELD" });
  });

  it("throws E_NOT_FOUND for unknown actions", async () => {
    await expect(authority.commit("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "E_NOT_FOUND",
    });
  });
});
