import type { ActionDefinition } from "./types.js";

/**
 * Declare a domain action with full type inference.
 *
 * ```ts
 * const createBooking = defineAction({
 *   type: "createBooking",
 *   hold: { ttlSeconds: 300 },
 *   validate: async (ctx, payload) => ({ allow: true }),
 *   apply: async (ctx, payload) => ({ bookingId: "..." }),
 * });
 * ```
 */
export function defineAction<Payload = unknown, Result = unknown>(
  definition: ActionDefinition<Payload, Result>,
): ActionDefinition<Payload, Result> {
  if (!definition.type.trim()) {
    throw new Error("exactly-once: action type must be a non-empty string");
  }
  return definition;
}
