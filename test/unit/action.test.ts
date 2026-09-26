import { describe, expect, it } from "vitest";
import { defineAction } from "../../src/index.js";

describe("defineAction", () => {
  it("returns the definition unchanged", () => {
    const definition = defineAction({
      type: "ping",
      apply: async () => ({ ok: true }),
    });

    expect(definition.type).toBe("ping");
    expect(definition.hold).toBeUndefined();
  });

  it("rejects empty action types", () => {
    expect(() => defineAction({ type: "  ", apply: async () => undefined })).toThrow(/non-empty/);
  });
});
