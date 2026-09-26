export type AuthorityErrorCode =
  | "E_ACTION_UNKNOWN"
  | "E_HOLD_EXPIRED"
  | "E_IDEMPOTENCY_MISMATCH"
  | "E_INVALID_KEY"
  | "E_NOT_FOUND"
  | "E_NOT_HELD";

/** Operational error raised by the authority (invalid usage or illegal state). */
export class AuthorityError extends Error {
  readonly code: AuthorityErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: AuthorityErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AuthorityError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Throw from an action's `apply` to reject the commit domain-side: the effect
 * rolls back, the action is marked rejected, and the caller receives the
 * reason (with optional alternatives).
 */
export class ActionRejected extends Error {
  readonly reason: string;
  readonly alternatives: readonly unknown[] | undefined;

  constructor(reason: string, alternatives?: readonly unknown[]) {
    super(reason);
    this.name = "ActionRejected";
    this.reason = reason;
    this.alternatives = alternatives;
  }
}
