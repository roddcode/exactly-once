import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Authority, createAuthority, defineAction } from "../../src/index.js";
import { openTestDatabase, type TestDb } from "../helpers/db.js";

interface ValuePayload {
  readonly value: number;
  readonly note?: string;
}

let alphaValidateCalls = 0;
let betaValidateCalls = 0;
let denyValidateCalls = 0;

const alpha = defineAction<ValuePayload, { ok: true }>({
  type: "alpha",
  validate: async () => {
    alphaValidateCalls += 1;
    return { allow: true };
  },
  apply: async (ctx, payload) => {
    await ctx.tx.query("insert into identity_domain (note) values ($1)", [
      `alpha:${payload.value}`,
    ]);
    return { ok: true };
  },
});

const beta = defineAction<ValuePayload, { ok: true }>({
  type: "beta",
  validate: async () => {
    betaValidateCalls += 1;
    return { allow: true };
  },
  apply: async (ctx, payload) => {
    await ctx.tx.query("insert into identity_domain (note) values ($1)", [`beta:${payload.value}`]);
    return { ok: true };
  },
});

const deny = defineAction<ValuePayload, { ok: true }>({
  type: "deny",
  validate: async () => {
    denyValidateCalls += 1;
    return { allow: false, reason: "denied" };
  },
  apply: async (ctx, payload) => {
    await ctx.tx.query("insert into identity_domain (note) values ($1)", [`deny:${payload.value}`]);
    return { ok: true };
  },
});

describe("idempotency identity", () => {
  let database: TestDb;
  let authority: Authority;
  let authorityA: Authority;
  let authorityB: Authority;

  beforeAll(async () => {
    database = await openTestDatabase();
    await database.db.query(
      "create table if not exists identity_domain (id serial primary key, note text)",
    );
    authority = createAuthority({
      db: database.db,
      scope: "identity",
      actions: [alpha, beta, deny],
    });
    authorityA = createAuthority({ db: database.db, scope: "identity-a", actions: [alpha] });
    authorityB = createAuthority({ db: database.db, scope: "identity-b", actions: [alpha] });
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await database.reset(["identity", "identity-a", "identity-b"]);
    await database.db.query("truncate table identity_domain restart identity");
    alphaValidateCalls = 0;
    betaValidateCalls = 0;
    denyValidateCalls = 0;
  });

  async function domainNotes(): Promise<string[]> {
    const rows = await database.db.query<{ note: string }>(
      "select note from identity_domain order by id",
    );
    return rows.map((row) => row.note);
  }

  async function expireHold(idempotencyKey: string): Promise<void> {
    await database.db.query(
      "update cg_actions set expires_at = now() - interval '1 minute' where scope = 'identity' and idempotency_key = $1",
      [idempotencyKey],
    );
  }

  async function mismatch(promise: Promise<unknown>): Promise<void> {
    await expect(promise).rejects.toMatchObject({ code: "E_IDEMPOTENCY_MISMATCH" });
  }

  it("rejects a different action type on a live hold", async () => {
    const first = await authority.propose("alpha", { value: 1 }, { idempotencyKey: "type-held" });
    expect(first.status).toBe("approved");

    await mismatch(authority.propose("beta", { value: 1 }, { idempotencyKey: "type-held" }));

    expect(betaValidateCalls).toBe(0);
    expect((await authority.get("type-held"))?.actionType).toBe("alpha");
    expect(await domainNotes()).toEqual([]);
  });

  it("rejects a different action type on an expired hold without reviving", async () => {
    const first = await authority.propose(
      "alpha",
      { value: 1 },
      { idempotencyKey: "type-expired" },
    );
    expect(first.status).toBe("approved");
    await expireHold("type-expired");

    await mismatch(authority.propose("beta", { value: 1 }, { idempotencyKey: "type-expired" }));

    expect(betaValidateCalls).toBe(0);
    const record = await authority.get("type-expired");
    expect(record?.actionType).toBe("alpha");
    expect(record?.status).toBe("expired");
    expect(await domainNotes()).toEqual([]);
  });

  it("rejects a different action type on a rejected action", async () => {
    const first = await authority.propose(
      "deny",
      { value: 1 },
      { idempotencyKey: "type-rejected" },
    );
    expect(first.status).toBe("rejected");

    await mismatch(authority.propose("beta", { value: 1 }, { idempotencyKey: "type-rejected" }));

    expect(denyValidateCalls).toBe(1);
    expect(betaValidateCalls).toBe(0);
    expect((await authority.get("type-rejected"))?.actionType).toBe("deny");
    expect(await domainNotes()).toEqual([]);
  });

  it("rejects a different action type on a committed action", async () => {
    const first = await authority.propose(
      "alpha",
      { value: 1 },
      { idempotencyKey: "type-committed" },
    );
    if (first.status !== "approved") throw new Error("expected approved");
    const committed = await authority.commit(first.actionId);
    expect(committed.status).toBe("committed");

    await mismatch(authority.propose("beta", { value: 1 }, { idempotencyKey: "type-committed" }));

    expect(betaValidateCalls).toBe(0);
    expect((await authority.get("type-committed"))?.actionType).toBe("alpha");
    expect(await domainNotes()).toEqual(["alpha:1"]);
  });

  it("rejects a different payload on a live hold", async () => {
    await authority.propose("alpha", { value: 1 }, { idempotencyKey: "payload-held" });

    await mismatch(authority.propose("alpha", { value: 2 }, { idempotencyKey: "payload-held" }));

    expect(alphaValidateCalls).toBe(1);
    expect(await domainNotes()).toEqual([]);
  });

  it("rejects a different payload on an expired hold without reviving", async () => {
    await authority.propose("alpha", { value: 1 }, { idempotencyKey: "payload-expired" });
    await expireHold("payload-expired");

    await mismatch(authority.propose("alpha", { value: 2 }, { idempotencyKey: "payload-expired" }));

    expect(alphaValidateCalls).toBe(1);
    const record = await authority.get("payload-expired");
    expect(record?.status).toBe("expired");
    expect(await domainNotes()).toEqual([]);
  });

  it("rejects a different payload on a rejected action", async () => {
    await authority.propose("deny", { value: 1 }, { idempotencyKey: "payload-rejected" });

    await mismatch(authority.propose("deny", { value: 2 }, { idempotencyKey: "payload-rejected" }));

    expect(denyValidateCalls).toBe(1);
    expect((await authority.get("payload-rejected"))?.status).toBe("rejected");
  });

  it("rejects a different payload on a committed action", async () => {
    const first = await authority.propose(
      "alpha",
      { value: 1 },
      { idempotencyKey: "payload-committed" },
    );
    if (first.status !== "approved") throw new Error("expected approved");
    const committed = await authority.commit(first.actionId);
    expect(committed.status).toBe("committed");

    await mismatch(
      authority.propose("alpha", { value: 2 }, { idempotencyKey: "payload-committed" }),
    );

    expect(alphaValidateCalls).toBe(1);
    expect(await domainNotes()).toEqual(["alpha:1"]);
  });

  it("treats reordered object properties as the same payload", async () => {
    const first = await authority.propose(
      "alpha",
      { value: 1, note: "same" },
      { idempotencyKey: "reordered" },
    );
    if (first.status !== "approved") throw new Error("expected approved");

    const second = await authority.propose(
      "alpha",
      { note: "same", value: 1 },
      { idempotencyKey: "reordered" },
    );

    expect(second).toEqual(first);
    expect(alphaValidateCalls).toBe(1);
  });

  it("keeps the same key independent across scopes", async () => {
    const first = await authorityA.propose("alpha", { value: 1 }, { idempotencyKey: "same-key" });
    const second = await authorityB.propose("alpha", { value: 1 }, { idempotencyKey: "same-key" });

    if (first.status !== "approved" || second.status !== "approved") {
      throw new Error("expected both approved");
    }
    expect(first.actionId).not.toBe(second.actionId);
    expect((await authorityA.get("same-key"))?.actionType).toBe("alpha");
    expect((await authorityB.get("same-key"))?.actionType).toBe("alpha");
  });
});
