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
});

describe("ActionRejected", () => {
  it("carries the reason and alternatives", () => {
    const rejection = new ActionRejected("slot_taken", [{ slot: "jueves-1600" }]);

    expect(rejection.reason).toBe("slot_taken");
    expect(rejection.alternatives).toEqual([{ slot: "jueves-1600" }]);
  });
});
