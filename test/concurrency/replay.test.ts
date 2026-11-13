import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Authority, createAuthority, defineAction } from "../../src/index.js";
import { openTestDatabase, type TestDb } from "../helpers/db.js";

const counted = defineAction<Record<string, never>, { ok: true }>({
  type: "counted",
  hold: { ttlSeconds: 60 },
  apply: async (ctx) => {
    await ctx.tx.query("update replay_counter set n = n + 1 where id = 1");
    return { ok: true };
  },
});

describe("same-action commit storm", () => {
  let database: TestDb;
  let authority: Authority;

  beforeAll(async () => {
    database = await openTestDatabase();
    await database.db.query(
      "create table if not exists replay_counter (id int primary key, n int not null)",
    );
    authority = createAuthority({ db: database.db, scope: "replay", actions: [counted] });
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await database.reset(["replay"]);
    await database.db.query("truncate table replay_counter");
    await database.db.query("insert into replay_counter (id, n) values (1, 0)");
  });

  it("runs apply once when 100 commits target the same action", async () => {
    const proposed = await authority.propose("counted", {}, { idempotencyKey: "storm" });
    if (proposed.status !== "approved") throw new Error("expected approved");

    const results = await Promise.all(
      Array.from({ length: 100 }, () => authority.commit(proposed.actionId)),
    );

    const committed = results.filter((result) => result.status === "committed");
    expect(committed).toHaveLength(100);
    for (const result of committed) {
      expect(result.receipt.actionId).toBe(proposed.actionId);
    }
    expect(new Set(committed.map((result) => JSON.stringify(result.receipt))).size).toBe(1);

    const counter = await database.db.query<{ n: number }>(
      "select n from replay_counter where id = 1",
    );
    expect(counter[0]?.n).toBe(1);
    const committedRows = await database.db.query<{ count: number }>(
      "select count(*)::int as count from cg_actions where scope = 'replay' and status = 'committed'",
    );
    expect(committedRows[0]?.count).toBe(1);
  });
});
