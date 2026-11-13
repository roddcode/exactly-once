import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Authority, createAuthority, defineAction } from "../../src/index.js";
import { openTestDatabase, type TestDb } from "../helpers/db.js";

interface NotePayload {
  readonly note: string;
}

const expiryAction = defineAction<NotePayload, { ok: true }>({
  type: "expiryAction",
  hold: { ttlSeconds: 60 },
  apply: async (ctx, payload) => {
    await ctx.tx.query("insert into expiry_domain (note) values ($1)", [payload.note]);
    return { ok: true };
  },
});

const slowValidate = defineAction<NotePayload, { ok: true }>({
  type: "slowValidate",
  hold: { ttlSeconds: 3 },
  validate: async (ctx) => {
    await ctx.tx.query("select pg_sleep(1)");
    return { allow: true };
  },
  apply: async (ctx, payload) => {
    await ctx.tx.query("insert into expiry_domain (note) values ($1)", [payload.note]);
    return { ok: true };
  },
});

describe("hold expiry and TTL", () => {
  let database: TestDb;
  let authority: Authority;

  beforeAll(async () => {
    database = await openTestDatabase();
    await database.db.query(
      "create table if not exists expiry_domain (id serial primary key, note text)",
    );
    authority = createAuthority({
      db: database.db,
      scope: "expiry",
      actions: [expiryAction, slowValidate],
    });
  });

  afterAll(async () => {
    await database?.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    await database.reset(["expiry"]);
    await database.db.query("truncate table expiry_domain restart identity");
  });

  async function expireInDb(idempotencyKey: string, seconds = 1): Promise<void> {
    await database.db.query(
      `update cg_actions
       set expires_at = clock_timestamp() - make_interval(secs => $2)
       where scope = 'expiry' and idempotency_key = $1`,
      [idempotencyKey, seconds],
    );
  }

  async function expireInFuture(idempotencyKey: string, seconds = 30): Promise<void> {
    await database.db.query(
      `update cg_actions
       set expires_at = clock_timestamp() + make_interval(secs => $2)
       where scope = 'expiry' and idempotency_key = $1`,
      [idempotencyKey, seconds],
    );
  }

  async function storedStatus(idempotencyKey: string): Promise<string | undefined> {
    const rows = await database.db.query<{ status: string }>(
      "select status from cg_actions where scope = 'expiry' and idempotency_key = $1",
      [idempotencyKey],
    );
    return rows[0]?.status;
  }

  async function remainingMs(idempotencyKey: string): Promise<number> {
    const rows = await database.db.query<{ remaining_ms: number }>(
      `select (extract(epoch from (expires_at - clock_timestamp())) * 1000)::float8 as remaining_ms
       from cg_actions
       where scope = 'expiry' and idempotency_key = $1`,
      [idempotencyKey],
    );
    return Number(rows[0]?.remaining_ms);
  }

  async function events(actionId: string): Promise<string[]> {
    const rows = await database.db.query<{ event: string }>(
      "select event from cg_events where action_id = $1 order by id",
      [actionId],
    );
    return rows.map((row) => row.event);
  }

  async function domainNotes(): Promise<string[]> {
    const rows = await database.db.query<{ note: string }>(
      "select note from expiry_domain order by id",
    );
    return rows.map((row) => row.note);
  }

  it("starts the TTL after validate approves, not when the transaction starts", async () => {
    const proposed = await authority.propose(
      "slowValidate",
      { note: "slow" },
      { idempotencyKey: "slow" },
    );
    if (proposed.status !== "approved") throw new Error("expected approved");

    // validate sleeps for one second; TTL is three seconds. The old
    // implementation would leave roughly two seconds, the new one roughly three.
    expect(await remainingMs("slow")).toBeGreaterThan(2_500);
  });

  it("persists the expired transition and event before throwing", async () => {
    const proposed = await authority.propose(
      "expiryAction",
      { note: "late" },
      { idempotencyKey: "late" },
    );
    if (proposed.status !== "approved") throw new Error("expected approved");
    await expireInDb("late");

    await expect(authority.commit(proposed.actionId)).rejects.toMatchObject({
      code: "E_HOLD_EXPIRED",
    });

    expect(await storedStatus("late")).toBe("expired");
    expect(await events(proposed.actionId)).toEqual(["held", "expired"]);
    expect((await authority.get("late"))?.status).toBe("expired");

    await expect(authority.commit(proposed.actionId)).rejects.toMatchObject({
      code: "E_HOLD_EXPIRED",
    });
    expect(await events(proposed.actionId)).toEqual(["held", "expired"]);
  });

  it("reports an effective expired status from get without writing", async () => {
    const proposed = await authority.propose(
      "expiryAction",
      { note: "read" },
      { idempotencyKey: "read" },
    );
    if (proposed.status !== "approved") throw new Error("expected approved");
    await expireInDb("read");

    expect((await authority.get("read"))?.status).toBe("expired");
    expect(await storedStatus("read")).toBe("held");
    expect(await events(proposed.actionId)).toEqual(["held"]);
  });

  it("uses PostgreSQL time rather than the application clock", async () => {
    const proposed = await authority.propose(
      "expiryAction",
      { note: "clock" },
      { idempotencyKey: "clock" },
    );
    if (proposed.status !== "approved") throw new Error("expected approved");
    await expireInFuture("clock", 30);

    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 3_600_000);
    try {
      const committed = await authority.commit(proposed.actionId);
      expect(committed.status).toBe("committed");
    } finally {
      spy.mockRestore();
    }

    expect(await storedStatus("clock")).toBe("committed");
  });

  it("revives after a materialized expiration without losing identity", async () => {
    const proposed = await authority.propose(
      "expiryAction",
      { note: "revive-after" },
      { idempotencyKey: "revive-after" },
    );
    if (proposed.status !== "approved") throw new Error("expected approved");
    await expireInDb("revive-after");

    await expect(authority.commit(proposed.actionId)).rejects.toMatchObject({
      code: "E_HOLD_EXPIRED",
    });

    const revived = await authority.propose(
      "expiryAction",
      { note: "revive-after" },
      { idempotencyKey: "revive-after" },
    );
    if (revived.status !== "approved") throw new Error("expected approved");

    const committed = await authority.commit(proposed.actionId);
    expect(committed.status).toBe("committed");
    expect(await events(proposed.actionId)).toEqual(["held", "expired", "revived", "committed"]);
    expect(await domainNotes()).toEqual(["revive-after"]);
  });

  it("allows commit after a revival that wins before expiration is materialized", async () => {
    const proposed = await authority.propose(
      "expiryAction",
      { note: "revive-before" },
      { idempotencyKey: "revive-before" },
    );
    if (proposed.status !== "approved") throw new Error("expected approved");
    await expireInDb("revive-before");

    const revived = await authority.propose(
      "expiryAction",
      { note: "revive-before" },
      { idempotencyKey: "revive-before" },
    );
    if (revived.status !== "approved") throw new Error("expected approved");

    const committed = await authority.commit(proposed.actionId);
    expect(committed.status).toBe("committed");
    expect(await events(proposed.actionId)).toEqual(["held", "revived", "committed"]);
    expect(await domainNotes()).toEqual(["revive-before"]);
  });

  it("serializes concurrent commit and revival without duplicating events", async () => {
    for (let index = 0; index < 5; index += 1) {
      const key = `race-${index}`;
      const proposed = await authority.propose(
        "expiryAction",
        { note: key },
        { idempotencyKey: key },
      );
      if (proposed.status !== "approved") throw new Error("expected approved");
      await expireInDb(key);

      const [commitResult, revivalResult] = await Promise.allSettled([
        authority.commit(proposed.actionId),
        authority.propose("expiryAction", { note: key }, { idempotencyKey: key }),
      ]);

      if (commitResult.status === "fulfilled") {
        expect(commitResult.value.status).toBe("committed");
      } else {
        expect(commitResult.reason).toMatchObject({ code: "E_HOLD_EXPIRED" });
      }

      if (revivalResult.status === "rejected") throw revivalResult.reason;
      expect(["approved", "committed"]).toContain(revivalResult.value.status);

      const eventNames = await events(proposed.actionId);
      expect(eventNames.filter((event) => event === "expired").length).toBeLessThanOrEqual(1);
      expect(eventNames.filter((event) => event === "committed").length).toBeLessThanOrEqual(1);
      expect([undefined, "held", "committed"]).toContain((await authority.get(key))?.status);
    }
  });
});
