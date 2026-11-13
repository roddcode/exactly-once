import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionRejected, type Authority, createAuthority, defineAction } from "../../src/index.js";
import { openTestDatabase, type TestDb } from "../helpers/db.js";

interface NotePayload {
  readonly note: string;
}

const writeThenReject = defineAction<NotePayload, { ok: true }>({
  type: "writeThenReject",
  apply: async (ctx, payload) => {
    await ctx.tx.query("insert into rejection_domain (note) values ($1)", [payload.note]);
    throw new ActionRejected("domain_says_no");
  },
});

const writeThenAllowValidate = defineAction<NotePayload, { ok: true }>({
  type: "writeThenAllowValidate",
  validate: async (ctx, payload) => {
    await ctx.tx.query("insert into rejection_domain (note) values ($1)", [
      `validate:${payload.note}`,
    ]);
    return { allow: true };
  },
  apply: async (ctx, payload) => {
    await ctx.tx.query("insert into rejection_domain (note) values ($1)", [
      `apply:${payload.note}`,
    ]);
    return { ok: true };
  },
});

const writeThenDenyValidate = defineAction<NotePayload, { ok: true }>({
  type: "writeThenDenyValidate",
  validate: async (ctx, payload) => {
    await ctx.tx.query("insert into rejection_domain (note) values ($1)", [
      `validate:${payload.note}`,
    ]);
    return { allow: false, reason: "denied" };
  },
  apply: async (ctx, payload) => {
    await ctx.tx.query("insert into rejection_domain (note) values ($1)", [
      `apply:${payload.note}`,
    ]);
    return { ok: true };
  },
});

const writeThenSucceed = defineAction<NotePayload, { ok: true }>({
  type: "writeThenSucceed",
  apply: async (ctx, payload) => {
    await ctx.tx.query("insert into rejection_domain (note) values ($1)", [payload.note]);
    return { ok: true };
  },
});

const abortedThenReject = defineAction<NotePayload, { ok: true }>({
  type: "abortedThenReject",
  apply: async (ctx, payload) => {
    await ctx.tx.query("insert into rejection_domain (note) values ($1)", [payload.note]);
    try {
      // Unique violation; the transaction is aborted until the savepoint is
      // rolled back. The rejection must still be recordable.
      await ctx.tx.query("insert into rejection_domain (note) values ($1)", [payload.note]);
    } catch {
      throw new ActionRejected("duplicate_note");
    }
    return { ok: true };
  },
});

const writeThenError = defineAction<NotePayload, { ok: true }>({
  type: "writeThenError",
  apply: async (ctx, payload) => {
    await ctx.tx.query("insert into rejection_domain (note) values ($1)", [payload.note]);
    throw new Error("boom");
  },
});

describe("rejection atomicity", () => {
  let database: TestDb;
  let authority: Authority;

  beforeAll(async () => {
    database = await openTestDatabase();
    await database.db.query(
      "create table if not exists rejection_domain (id serial primary key, note text unique)",
    );
    authority = createAuthority({
      db: database.db,
      scope: "rejection",
      actions: [
        writeThenReject,
        writeThenAllowValidate,
        writeThenDenyValidate,
        writeThenSucceed,
        abortedThenReject,
        writeThenError,
      ],
    });
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await database.reset(["rejection"]);
    await database.db.query("truncate table rejection_domain restart identity");
  });

  async function domainNotes(): Promise<string[]> {
    const rows = await database.db.query<{ note: string }>(
      "select note from rejection_domain order by id",
    );
    return rows.map((row) => row.note);
  }

  async function events(actionId: string): Promise<string[]> {
    const rows = await database.db.query<{ event: string }>(
      "select event from cg_events where action_id = $1 order by id",
      [actionId],
    );
    return rows.map((row) => row.event);
  }

  async function expireHold(idempotencyKey: string): Promise<void> {
    await database.db.query(
      "update cg_actions set expires_at = now() - interval '1 minute' where scope = 'rejection' and idempotency_key = $1",
      [idempotencyKey],
    );
  }

  it("rolls back apply writes before recording ActionRejected", async () => {
    const proposed = await authority.propose(
      "writeThenReject",
      { note: "apply" },
      { idempotencyKey: "r1" },
    );
    if (proposed.status !== "approved") throw new Error("expected approved");

    const result = await authority.commit(proposed.actionId);

    expect(result).toEqual({ status: "rejected", reason: "domain_says_no" });
    expect(await domainNotes()).toEqual([]);
    expect((await authority.get("r1"))?.status).toBe("rejected");
    expect(await events(proposed.actionId)).toEqual(["held", "rejected"]);
  });

  it("discards validate writes even when validation allows", async () => {
    const proposed = await authority.propose(
      "writeThenAllowValidate",
      { note: "v" },
      { idempotencyKey: "r2" },
    );
    if (proposed.status !== "approved") throw new Error("expected approved");

    expect(await domainNotes()).toEqual([]);

    const result = await authority.commit(proposed.actionId);

    expect(result.status).toBe("committed");
    expect(await domainNotes()).toEqual(["apply:v"]);
  });

  it("discards validate writes on a revived hold too", async () => {
    const first = await authority.propose(
      "writeThenAllowValidate",
      { note: "revive" },
      { idempotencyKey: "r7" },
    );
    if (first.status !== "approved") throw new Error("expected approved");
    await expireHold("r7");

    const revived = await authority.propose(
      "writeThenAllowValidate",
      { note: "revive" },
      { idempotencyKey: "r7" },
    );
    if (revived.status !== "approved") throw new Error("expected approved");

    expect(await domainNotes()).toEqual([]);

    const result = await authority.commit(revived.actionId);

    expect(result.status).toBe("committed");
    expect(await domainNotes()).toEqual(["apply:revive"]);
  });

  it("discards validate writes when validation denies", async () => {
    const proposed = await authority.propose(
      "writeThenDenyValidate",
      { note: "v" },
      { idempotencyKey: "r3" },
    );

    expect(proposed).toEqual({ status: "rejected", reason: "denied" });
    expect(await domainNotes()).toEqual([]);

    const record = await authority.get("r3");
    if (!record) throw new Error("expected record");
    expect(record.status).toBe("rejected");
    expect(await events(record.id)).toEqual(["held", "rejected"]);
  });

  it("keeps apply writes when the commit succeeds", async () => {
    const proposed = await authority.propose(
      "writeThenSucceed",
      { note: "ok" },
      { idempotencyKey: "r4" },
    );
    if (proposed.status !== "approved") throw new Error("expected approved");

    const result = await authority.commit(proposed.actionId);

    expect(result.status).toBe("committed");
    expect(await domainNotes()).toEqual(["ok"]);
  });

  it("rolls back apply writes and keeps the hold on a generic error", async () => {
    const proposed = await authority.propose(
      "writeThenError",
      { note: "boom" },
      { idempotencyKey: "r5" },
    );
    if (proposed.status !== "approved") throw new Error("expected approved");

    await expect(authority.commit(proposed.actionId)).rejects.toThrow("boom");

    expect(await domainNotes()).toEqual([]);
    expect((await authority.get("r5"))?.status).toBe("held");
  });

  it("can record a rejection after a caught SQL error inside apply", async () => {
    const proposed = await authority.propose(
      "abortedThenReject",
      { note: "dup" },
      { idempotencyKey: "r6" },
    );
    if (proposed.status !== "approved") throw new Error("expected approved");

    const result = await authority.commit(proposed.actionId);

    expect(result).toEqual({ status: "rejected", reason: "duplicate_note" });
    expect(await domainNotes()).toEqual([]);
    expect((await authority.get("r6"))?.status).toBe("rejected");
  });
});
