import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionRejected, type Authority, createAuthority, defineAction } from "../../src/index.js";
import { openTestDatabase, type TestDb } from "../helpers/db.js";

interface SlotPayload {
  readonly slot: string;
}

const bookSlot = defineAction<SlotPayload, { slot: string }>({
  type: "bookSlot",
  hold: { ttlSeconds: 60 },
  validate: async (ctx, payload) => {
    const rows = await ctx.tx.query("select 1 from race_slots where id = $1", [payload.slot]);
    return rows.length > 0 ? { allow: true } : { allow: false, reason: "slot_not_found" };
  },
  apply: async (ctx, payload) => {
    const updated = await ctx.tx.query<{ id: string }>(
      "update race_slots set booking_key = $1 where id = $2 and booking_key is null returning id",
      [ctx.idempotencyKey, payload.slot],
    );
    if (updated.length === 0) {
      throw new ActionRejected("slot_taken");
    }
    return { slot: payload.slot };
  },
});

const WORKERS = 40;

describe("concurrency", () => {
  let database: TestDb;
  let authority: Authority;

  beforeAll(async () => {
    database = await openTestDatabase();
    await database.db.query(
      "create table if not exists race_slots (id text primary key, booking_key text)",
    );
    authority = createAuthority({ db: database.db, scope: "race", actions: [bookSlot] });
  });

  afterAll(async () => {
    await database?.close();
  });

  it(`${WORKERS} agents race for one slot: exactly one commits`, async () => {
    await database.reset(["race"]);
    await database.db.query("truncate table race_slots");
    await database.db.query("insert into race_slots (id) values ('camilla-1')");

    const results = await Promise.all(
      Array.from({ length: WORKERS }, async (_, index) => {
        const key = `agent-${index}`;
        const proposal = await authority.propose(
          "bookSlot",
          { slot: "camilla-1" },
          { idempotencyKey: key },
        );
        if (proposal.status !== "approved") {
          return { key, outcome: proposal.status };
        }
        const commit = await authority.commit(proposal.actionId);
        return { key, outcome: commit.status };
      }),
    );

    const committed = results.filter((result) => result.outcome === "committed");
    const rejected = results.filter((result) => result.outcome === "rejected");

    expect(committed).toHaveLength(1);
    expect(rejected).toHaveLength(WORKERS - 1);

    const slot = await database.db.query<{ booking_key: string | null }>(
      "select booking_key from race_slots where id = 'camilla-1'",
    );
    expect(slot[0]?.booking_key).toBe(committed[0]?.key);

    const committedRows = await database.db.query<{ count: string }>(
      "select count(*)::text as count from cg_actions where scope = 'race' and status = 'committed'",
    );
    expect(committedRows[0]?.count).toBe("1");
  });

  it("a storm of concurrent proposals with the same key yields one hold", async () => {
    await database.reset(["race"]);
    await database.db.query("truncate table race_slots");
    await database.db.query("insert into race_slots (id) values ('camilla-2')");

    const proposals = await Promise.all(
      Array.from({ length: 20 }, () =>
        authority.propose("bookSlot", { slot: "camilla-2" }, { idempotencyKey: "same-key" }),
      ),
    );

    const approved = proposals.filter((proposal) => proposal.status === "approved");
    expect(approved).toHaveLength(20);

    const distinctIds = new Set(
      approved.map((proposal) => (proposal.status === "approved" ? proposal.actionId : "")),
    );
    expect(distinctIds.size).toBe(1);
  });
});
