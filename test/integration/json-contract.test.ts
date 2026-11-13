import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Authority, createAuthority, defineAction } from "../../src/index.js";
import { openTestDatabase, type TestDb } from "../helpers/db.js";

const jsonEcho = defineAction<unknown, unknown>({
  type: "jsonEcho",
  apply: async (ctx, payload) => {
    await ctx.tx.query("insert into json_domain (note) values ('json')");
    return { echo: payload };
  },
});

const voidResult = defineAction<Record<string, never>, void>({
  type: "voidResult",
  apply: async () => undefined,
});

const dateResult = defineAction<Record<string, never>, Date>({
  type: "dateResult",
  apply: async (ctx) => {
    await ctx.tx.query("insert into json_domain (note) values ('date')");
    return new Date("2026-01-01T00:00:00.000Z");
  },
});

const bigintResult = defineAction<Record<string, never>, bigint>({
  type: "bigintResult",
  apply: async (ctx) => {
    await ctx.tx.query("insert into json_domain (note) values ('bigint')");
    return 1n;
  },
});

const undefinedResult = defineAction<Record<string, never>, unknown>({
  type: "undefinedResult",
  apply: async (ctx) => {
    await ctx.tx.query("insert into json_domain (note) values ('undefined')");
    return { missing: undefined };
  },
});

const circularPayload = (): Record<string, unknown> => {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
};

const symbolKeyPayload = (): Record<PropertyKey, unknown> =>
  Object.assign({}, { [Symbol("secret")]: 1 });

const nonEnumerablePayload = (): Record<string, unknown> =>
  Object.defineProperty({}, "hidden", { value: 1, enumerable: false });

const accessorPayload = (): Record<string, unknown> =>
  Object.defineProperty({}, "value", { get: () => 1, enumerable: true });

const extraArrayProperty = (): unknown[] => Object.assign([1, 2], { extra: true });

const invalidPayloads: ReadonlyArray<readonly [string, unknown]> = [
  ["undefined", undefined],
  ["undefined-property", { a: undefined }],
  ["undefined-array", [undefined]],
  ["sparse-array", Array(2)],
  ["date", new Date("2026-01-01T00:00:00.000Z")],
  ["date-nested", { at: new Date("2026-01-01T00:00:00.000Z") }],
  ["bigint", 1n],
  ["nan", Number.NaN],
  ["infinity", Number.POSITIVE_INFINITY],
  ["function", () => 1],
  ["symbol", Symbol("x")],
  ["circular", circularPayload()],
  ["map", new Map()],
  ["set", new Set()],
  [
    "class-instance",
    new (class Point {
      readonly x = 1;
    })(),
  ],
  ["symbol-key", symbolKeyPayload()],
  ["non-enumerable", nonEnumerablePayload()],
  ["accessor", accessorPayload()],
  ["array-extra-property", extraArrayProperty()],
];

describe("JSON payload and receipt contract", () => {
  let database: TestDb;
  let authority: Authority;

  beforeAll(async () => {
    database = await openTestDatabase();
    await database.db.query(
      "create table if not exists json_domain (id serial primary key, note text)",
    );
    authority = createAuthority({
      db: database.db,
      scope: "json",
      actions: [jsonEcho, voidResult, dateResult, bigintResult, undefinedResult],
    });
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await database.reset(["json"]);
    await database.db.query("truncate table json_domain restart identity");
  });

  async function domainNotes(): Promise<string[]> {
    const rows = await database.db.query<{ note: string }>(
      "select note from json_domain order by id",
    );
    return rows.map((row) => row.note);
  }

  it.each(invalidPayloads)("rejects invalid payload: %s", async (label, payload) => {
    await expect(
      authority.propose("jsonEcho", payload, { idempotencyKey: `invalid-${label}` }),
    ).rejects.toMatchObject({ code: "E_INVALID_PAYLOAD" });
    expect(await authority.get(`invalid-${label}`)).toBeNull();
  });

  it("accepts valid JSON values and preserves them in the receipt", async () => {
    const payload = { a: 1, b: [true, null, "x"], c: { d: 2 } };
    const proposed = await authority.propose("jsonEcho", payload, { idempotencyKey: "valid-json" });
    if (proposed.status !== "approved") throw new Error("expected approved");

    const first = await authority.commit(proposed.actionId);
    if (first.status !== "committed") throw new Error("expected committed");
    expect(first.receipt.result).toEqual({ echo: payload });

    const replay = await authority.commit(proposed.actionId);
    expect(replay).toEqual(first);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));

    const stored = await authority.get("valid-json");
    expect(stored?.receipt).toEqual(first.receipt);
  });

  it("treats reordered object properties as the same payload", async () => {
    const first = await authority.propose(
      "jsonEcho",
      { a: 1, b: 2 },
      { idempotencyKey: "reordered-json" },
    );
    if (first.status !== "approved") throw new Error("expected approved");

    const second = await authority.propose(
      "jsonEcho",
      { b: 2, a: 1 },
      { idempotencyKey: "reordered-json" },
    );

    expect(second).toEqual(first);
  });

  it("returns the committed receipt for an equivalent reordered payload", async () => {
    const first = await authority.propose(
      "jsonEcho",
      { a: 1, b: 2 },
      { idempotencyKey: "reordered-committed" },
    );
    if (first.status !== "approved") throw new Error("expected approved");
    const committed = await authority.commit(first.actionId);
    if (committed.status !== "committed") throw new Error("expected committed");

    const replay = await authority.propose(
      "jsonEcho",
      { b: 2, a: 1 },
      { idempotencyKey: "reordered-committed" },
    );

    expect(replay).toEqual({ status: "committed", receipt: committed.receipt });
  });

  it("treats array order as significant", async () => {
    await authority.propose("jsonEcho", [1, 2], { idempotencyKey: "array-order" });

    await expect(
      authority.propose("jsonEcho", [2, 1], { idempotencyKey: "array-order" }),
    ).rejects.toMatchObject({ code: "E_IDEMPOTENCY_MISMATCH" });
  });

  it("distinguishes null from an absent property", async () => {
    await authority.propose("jsonEcho", { a: null }, { idempotencyKey: "null-absent" });

    await expect(
      authority.propose("jsonEcho", {}, { idempotencyKey: "null-absent" }),
    ).rejects.toMatchObject({ code: "E_IDEMPOTENCY_MISMATCH" });
  });

  it("distinguishes null from an absent property on a committed action", async () => {
    const first = await authority.propose(
      "jsonEcho",
      { a: null },
      { idempotencyKey: "null-absent-committed" },
    );
    if (first.status !== "approved") throw new Error("expected approved");
    const committed = await authority.commit(first.actionId);
    if (committed.status !== "committed") throw new Error("expected committed");

    await expect(
      authority.propose("jsonEcho", {}, { idempotencyKey: "null-absent-committed" }),
    ).rejects.toMatchObject({ code: "E_IDEMPOTENCY_MISMATCH" });
  });

  it("normalizes a void result to null and replays the stored receipt", async () => {
    const proposed = await authority.propose("voidResult", {}, { idempotencyKey: "void" });
    if (proposed.status !== "approved") throw new Error("expected approved");

    const first = await authority.commit(proposed.actionId);
    if (first.status !== "committed") throw new Error("expected committed");
    expect(first.receipt.result).toBeNull();

    const replay = await authority.commit(proposed.actionId);
    expect(replay).toEqual(first);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expect((await authority.get("void"))?.receipt?.result).toBeNull();
  });

  it.each([
    ["dateResult", "date"],
    ["bigintResult", "bigint"],
    ["undefinedResult", "undefined"],
  ])("rejects an invalid apply result from %s", async (actionType, key) => {
    const proposed = await authority.propose(actionType, {}, { idempotencyKey: key });
    if (proposed.status !== "approved") throw new Error("expected approved");

    await expect(authority.commit(proposed.actionId)).rejects.toMatchObject({
      code: "E_INVALID_RESULT",
    });

    expect((await authority.get(key))?.status).toBe("held");
    expect(await domainNotes()).toEqual([]);
  });
});
