import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Authority, createAuthority, defineAction } from "../../src/index.js";
import { openTestDatabase, type TestDb } from "../helpers/db.js";

type Payload = { amount: number; nested: { amount: number } };

const topLevelMutation = defineAction<Payload, { amount: number }>({
  type: "topLevelMutation",
  hold: { ttlSeconds: 300 },
  validate: async (_ctx, payload) => {
    payload.amount = 200;
    return payload.amount === 200
      ? { allow: true }
      : { allow: false, reason: "mutation_did_not_apply" };
  },
  apply: async (_ctx, payload) => ({ amount: payload.amount }),
});

const nestedMutation = defineAction<Payload, { amount: number }>({
  type: "nestedMutation",
  hold: { ttlSeconds: 300 },
  validate: async (_ctx, payload) => {
    payload.nested.amount = 200;
    return payload.nested.amount === 200
      ? { allow: true }
      : { allow: false, reason: "mutation_did_not_apply" };
  },
  apply: async (_ctx, payload) => ({ amount: payload.nested.amount }),
});

let validateCalls = 0;

const revivalMutation = defineAction<Payload, { amount: number }>({
  type: "revivalMutation",
  hold: { ttlSeconds: 300 },
  validate: async (_ctx, payload) => {
    validateCalls += 1;
    if (validateCalls > 1) {
      payload.amount = 200;
      return payload.amount === 200
        ? { allow: true }
        : { allow: false, reason: "mutation_did_not_apply" };
    }
    return { allow: true };
  },
  apply: async (_ctx, payload) => ({ amount: payload.amount }),
});

const scope = "validate-payload";
const makePayload = (): Payload => ({ amount: 100, nested: { amount: 100 } });

describe("validate payload isolation", () => {
  let database: TestDb;
  let authority: Authority;

  beforeAll(async () => {
    database = await openTestDatabase();
    authority = createAuthority({
      db: database.db,
      scope,
      actions: [topLevelMutation, nestedMutation, revivalMutation],
    });
    await authority.migrate();
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    validateCalls = 0;
    await database.reset([scope]);
  });

  it("rejects a top-level mutation instead of approving a different value", async () => {
    const input = makePayload();

    await expect(
      authority.propose("topLevelMutation", input, { idempotencyKey: "top" }),
    ).rejects.toThrow(TypeError);

    expect(input.amount).toBe(100);
    await expect(authority.get("top")).resolves.toBeNull();
  });

  it("rejects a nested mutation instead of approving a different value", async () => {
    const input = makePayload();

    await expect(
      authority.propose("nestedMutation", input, { idempotencyKey: "nested" }),
    ).rejects.toThrow(TypeError);

    expect(input.nested.amount).toBe(100);
    await expect(authority.get("nested")).resolves.toBeNull();
  });

  it("rejects a mutating validate during revival", async () => {
    const input = makePayload();
    const first = await authority.propose("revivalMutation", input, {
      idempotencyKey: "revival",
    });
    expect(first.status).toBe("approved");

    await database.db.query(
      "update cg_actions set expires_at = clock_timestamp() - interval '1 second' where scope = $1 and idempotency_key = $2",
      [scope, "revival"],
    );

    await expect(
      authority.propose("revivalMutation", input, { idempotencyKey: "revival" }),
    ).rejects.toThrow(TypeError);

    const record = await authority.get("revival");
    expect(record?.status).toBe("expired");

    const events = await database.db.query<{ n: number }>(
      "select count(*)::int as n from cg_events e join cg_actions a on a.id = e.action_id where a.scope = $1 and a.idempotency_key = $2 and e.event = 'revived'",
      [scope, "revival"],
    );
    expect(events[0]?.n).toBe(0);
  });
});
