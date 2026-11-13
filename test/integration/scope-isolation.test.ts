import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Authority, createAuthority, defineAction } from "../../src/index.js";
import { openTestDatabase, type TestDb } from "../helpers/db.js";

interface BookPayload {
  readonly note: string;
}

const book = defineAction<BookPayload, { ok: true }>({
  type: "book",
  apply: async (ctx, payload) => {
    await ctx.tx.query("insert into scope_domain (note) values ($1)", [payload.note]);
    return { ok: true };
  },
});

describe("scope isolation", () => {
  let database: TestDb;
  let authorityA: Authority;
  let authorityB: Authority;

  beforeAll(async () => {
    database = await openTestDatabase();
    await database.db.query(
      "create table if not exists scope_domain (id serial primary key, note text)",
    );
    authorityA = createAuthority({ db: database.db, scope: "scope-a", actions: [book] });
    authorityB = createAuthority({ db: database.db, scope: "scope-b", actions: [book] });
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await database.reset(["scope-a", "scope-b"]);
    await database.db.query("truncate table scope_domain restart identity");
  });

  async function domainNotes(): Promise<string[]> {
    const rows = await database.db.query<{ note: string }>(
      "select note from scope_domain order by id",
    );
    return rows.map((row) => row.note);
  }

  it("does not let another scope commit an action by uuid", async () => {
    const proposed = await authorityA.propose("book", { note: "a" }, { idempotencyKey: "cross" });
    if (proposed.status !== "approved") throw new Error("expected approved");

    await expect(authorityB.commit(proposed.actionId)).rejects.toMatchObject({
      code: "E_NOT_FOUND",
    });

    expect((await authorityA.get("cross"))?.status).toBe("held");
    expect(await authorityB.get("cross")).toBeNull();
    expect(await domainNotes()).toEqual([]);

    const committed = await authorityA.commit(proposed.actionId);
    expect(committed.status).toBe("committed");
    expect(await domainNotes()).toEqual(["a"]);
  });

  it("lets each scope commit its own action with the same key", async () => {
    const first = await authorityA.propose("book", { note: "a" }, { idempotencyKey: "same-key" });
    const second = await authorityB.propose("book", { note: "b" }, { idempotencyKey: "same-key" });
    if (first.status !== "approved" || second.status !== "approved") {
      throw new Error("expected both approved");
    }
    expect(first.actionId).not.toBe(second.actionId);

    expect((await authorityA.commit(first.actionId)).status).toBe("committed");
    expect((await authorityB.commit(second.actionId)).status).toBe("committed");
    expect(await domainNotes()).toEqual(["a", "b"]);
  });
});
