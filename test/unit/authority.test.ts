import { describe, expect, it } from "vitest";
import {
  ActionRejected,
  AuthorityError,
  createAuthority,
  type Database,
  defineAction,
} from "../../src/index.js";

const neverCalled: Database = {
  query: () => {
    throw new Error("database should not be called in this test");
  },
  transaction: () => {
    throw new Error("database should not be called in this test");
  },
};

const ping = defineAction<{ value: number }, { ok: true }>({
  type: "ping",
  apply: () => ({ ok: true }),
});

describe("createAuthority", () => {
  it("rejects duplicate action types", () => {
    expect(() => createAuthority({ db: neverCalled, actions: [ping, ping] })).toThrow(/duplicate/);
  });

  it("rejects unknown action types before touching the database", async () => {
    const authority = createAuthority({ db: neverCalled, actions: [ping] });

    await expect(authority.propose("unknown", {}, { idempotencyKey: "k1" })).rejects.toMatchObject({
      code: "E_ACTION_UNKNOWN",
    });
  });

  it("validates idempotency keys before touching the database", async () => {
    const authority = createAuthority({ db: neverCalled, actions: [ping] });

    await expect(authority.propose("ping", {}, { idempotencyKey: "" })).rejects.toBeInstanceOf(
      AuthorityError,
    );
    await expect(
      authority.propose("ping", {}, { idempotencyKey: "x".repeat(256) }),
    ).rejects.toMatchObject({ code: "E_INVALID_KEY" });
  });

  it("rejects invalid default hold TTLs", () => {
    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, "60"]) {
      expect(() =>
        createAuthority({
          db: neverCalled,
          actions: [ping],
          defaultHoldTtlSeconds: ttl as number,
        }),
      ).toThrow(/finite positive/);
    }
  });

  it("rejects invalid action hold TTLs", () => {
    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, "60"]) {
      const action = defineAction({
        type: "invalid-ttl",
        hold: { ttlSeconds: ttl as number },
        apply: () => ({ ok: true }),
      });
      expect(() => createAuthority({ db: neverCalled, actions: [action] })).toThrow(
        /finite positive/,
      );
    }
  });

  it("accepts finite positive hold TTLs", () => {
    const action = defineAction({
      type: "valid-ttl",
      hold: { ttlSeconds: 0.5 },
      apply: () => ({ ok: true }),
    });
    expect(() =>
      createAuthority({ db: neverCalled, actions: [action], defaultHoldTtlSeconds: 1 }),
    ).not.toThrow();
  });
});

describe("ActionRejected", () => {
  it("carries the reason and alternatives", () => {
    const rejection = new ActionRejected("slot_taken", [{ slot: "jueves-1600" }]);

    expect(rejection.reason).toBe("slot_taken");
    expect(rejection.alternatives).toEqual([{ slot: "jueves-1600" }]);
  });
});
