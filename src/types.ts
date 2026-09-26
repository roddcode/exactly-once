/**
 * A minimal structural database client. Any Postgres driver can satisfy it:
 * `pg`, `postgres.js`, Drizzle or Neon adapters are ~20 lines (see adapters/).
 */
export interface Client {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<R[]>;
}

/** A client that can open transactions. All authority writes run inside one. */
export interface Database extends Client {
  transaction<T>(fn: (tx: Client) => Promise<T>): Promise<T>;
}

export type ActionStatus = "held" | "committed" | "rejected" | "expired";

/** Context handed to `validate` and `apply`, inside the corresponding transaction. */
export interface TxContext {
  readonly tx: Client;
  readonly scope: string;
  readonly actionId: string;
  readonly actionType: string;
  readonly idempotencyKey: string;
}

/**
 * The domain verdict for a proposal. `rejected` may carry alternatives the
 * caller can offer instead (e.g. other available slots).
 */
export type Decision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly reason: string;
      readonly alternatives?: readonly unknown[];
    };

export interface HoldOptions {
  /** Seconds the hold stays valid before it can be revived. Default: 300. */
  readonly ttlSeconds?: number;
}

/**
 * A domain action. `validate` decides against live state; `apply` commits the
 * effect. Both run inside transactions owned by the authority.
 */
export interface ActionDefinition<Payload = unknown, Result = unknown> {
  readonly type: string;
  readonly validate?: (ctx: TxContext, payload: Payload) => Decision | Promise<Decision>;
  /**
   * Commit the effect. Runs inside the commit transaction: if it throws, the
   * whole commit rolls back and the hold stays. Throw `ActionRejected` to end
   * the action as rejected with a domain reason.
   */
  readonly apply: (ctx: TxContext, payload: Payload) => Result | Promise<Result>;
  readonly hold?: HoldOptions;
}

/** Immutable proof of a committed action. Replays return the same receipt. */
export interface Receipt<Result = unknown> {
  readonly actionId: string;
  readonly actionType: string;
  readonly idempotencyKey: string;
  readonly committedAt: string;
  readonly result: Result;
}

/** Result of proposing an action. */
export type Proposal =
  | { readonly status: "approved"; readonly actionId: string; readonly expiresAt: string }
  | { readonly status: "committed"; readonly receipt: Receipt }
  | {
      readonly status: "rejected";
      readonly reason: string;
      readonly alternatives?: readonly unknown[];
    };

/** Result of committing an action. */
export type CommitResult =
  | { readonly status: "committed"; readonly receipt: Receipt }
  | {
      readonly status: "rejected";
      readonly reason: string;
      readonly alternatives?: readonly unknown[];
    };

/** Current state of an action, as returned by `authority.get()`. */
export interface ActionRecord {
  readonly id: string;
  readonly actionType: string;
  readonly idempotencyKey: string;
  readonly status: ActionStatus;
  readonly expiresAt: string | null;
  readonly receipt: Receipt | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
