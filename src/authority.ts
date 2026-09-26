import { ActionRejected, AuthorityError } from "./errors.js";
import { migrate } from "./migrations.js";
import type {
  ActionDefinition,
  ActionRecord,
  ActionStatus,
  Client,
  CommitResult,
  Database,
  Decision,
  Proposal,
  Receipt,
  TxContext,
} from "./types.js";

/** Type-erased action stored in the registry. */
interface ErasedAction {
  readonly type: string;
  readonly hold?: { readonly ttlSeconds?: number };
  readonly validate?: (ctx: TxContext, payload: unknown) => Decision | Promise<Decision>;
  readonly apply: (ctx: TxContext, payload: unknown) => unknown;
}

interface ActionRow {
  id: string;
  scope: string;
  action_type: string;
  idempotency_key: string;
  status: ActionStatus;
  payload: unknown;
  decision: { reason?: string; alternatives?: unknown[] } | null;
  receipt: Receipt | null;
  expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ProposeOptions {
  readonly idempotencyKey: string;
}

export interface Authority {
  /** Create the authority tables. Idempotent; run at boot. */
  migrate(): Promise<void>;
  /** Propose an action. Returns a hold (approved), a rejection, or the receipt of a replay. */
  propose<Payload = unknown>(
    actionType: string,
    payload: Payload,
    options: ProposeOptions,
  ): Promise<Proposal>;
  /** Commit a held action exactly once. Replays return the same receipt. */
  commit(actionId: string): Promise<CommitResult>;
  /** Inspect an action by idempotency key. Never executes anything. */
  get(idempotencyKey: string): Promise<ActionRecord | null>;
}

export interface AuthorityOptions {
  readonly db: Database;
  /** Tenancy/partition boundary for idempotency keys. Default: "default". */
  readonly scope?: string;
  readonly actions: readonly ActionDefinition<never, unknown>[];
  /** Default hold TTL in seconds when an action does not declare one. Default: 300. */
  readonly defaultHoldTtlSeconds?: number;
}

const DEFAULT_HOLD_TTL_SECONDS = 300;
const MAX_KEY_LENGTH = 255;

export function createAuthority(options: AuthorityOptions): Authority {
  const scope = options.scope ?? "default";
  const defaultTtl = options.defaultHoldTtlSeconds ?? DEFAULT_HOLD_TTL_SECONDS;
  const registry = new Map<string, ErasedAction>();

  for (const action of options.actions) {
    if (!action.type.trim()) {
      throw new Error("exactly-once: action type must be a non-empty string");
    }
    if (registry.has(action.type)) {
      throw new Error(`exactly-once: duplicate action type "${action.type}"`);
    }
    // Types are erased only here: callers stay strongly typed, and payloads are
    // checked against live state at propose time, not at compile time.
    registry.set(action.type, action as unknown as ErasedAction);
  }

  function actionFor(actionType: string): ErasedAction {
    const action = registry.get(actionType);
    if (!action) {
      throw new AuthorityError("E_ACTION_UNKNOWN", `unknown action type: "${actionType}"`);
    }
    return action;
  }

  return {
    migrate: () => migrate(options.db),

    async propose(actionType, payload, proposeOptions) {
      const action = actionFor(actionType);
      const key = proposeOptions?.idempotencyKey;
      if (typeof key !== "string" || key.trim().length === 0 || key.length > MAX_KEY_LENGTH) {
        throw new AuthorityError(
          "E_INVALID_KEY",
          `idempotencyKey must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`,
        );
      }
      const ttlSeconds = action.hold?.ttlSeconds ?? defaultTtl;

      return options.db.transaction(async (tx) => {
        const inserted = await tx.query<ActionRow>(
          `insert into cg_actions (scope, action_type, idempotency_key, status, payload, expires_at)
           values ($1, $2, $3, 'held', $4::jsonb, now() + make_interval(secs => $5))
           on conflict (scope, idempotency_key) do nothing
           returning *`,
          [scope, actionType, key, JSON.stringify(payload), ttlSeconds],
        );

        const created = inserted[0];
        if (created) {
          await insertEvent(tx, created.id, "held", { payload });
          const decision = action.validate
            ? await action.validate(context(tx, created), payload)
            : null;
          if (decision && !decision.allow) {
            await rejectRow(tx, created.id, decision);
            return rejectedProposal(decision);
          }
          return {
            status: "approved",
            actionId: created.id,
            expiresAt: toIso(created.expires_at),
          };
        }

        const existing = await tx.query<ActionRow>(
          "select * from cg_actions where scope = $1 and idempotency_key = $2 for update",
          [scope, key],
        );
        const row = existing[0];
        if (!row) {
          throw new Error(
            "exactly-once: invariant violated, conflicted insert without a persisted row",
          );
        }
        if (row.status === "committed") {
          return { status: "committed", receipt: storedReceipt(row) };
        }
        if (row.status === "held" && !isExpired(row)) {
          if (canonical(row.payload) !== canonical(payload)) {
            throw new AuthorityError(
              "E_IDEMPOTENCY_MISMATCH",
              `idempotency key "${key}" is held with a different payload`,
            );
          }
          return { status: "approved", actionId: row.id, expiresAt: toIso(row.expires_at) };
        }

        if (canonical(row.payload) !== canonical(payload)) {
          throw new AuthorityError(
            "E_IDEMPOTENCY_MISMATCH",
            `idempotency key "${key}" was already used with a different payload`,
          );
        }
        const decision = action.validate ? await action.validate(context(tx, row), payload) : null;
        if (decision && !decision.allow) {
          await rejectRow(tx, row.id, decision);
          return rejectedProposal(decision);
        }
        const revived = await tx.query<ActionRow>(
          `update cg_actions
           set status = 'held', decision = null, receipt = null,
               expires_at = now() + make_interval(secs => $2), updated_at = now()
           where id = $1
           returning *`,
          [row.id, ttlSeconds],
        );
        const fresh = revived[0];
        if (!fresh) {
          throw new Error("exactly-once: invariant violated, revive update returned no row");
        }
        await insertEvent(tx, fresh.id, "revived", {});
        return { status: "approved", actionId: fresh.id, expiresAt: toIso(fresh.expires_at) };
      });
    },

    async commit(actionId) {
      return options.db.transaction(async (tx) => {
        const found = await tx.query<ActionRow>(
          "select * from cg_actions where id = $1 for update",
          [actionId],
        );
        const row = found[0];
        if (!row) {
          throw new AuthorityError("E_NOT_FOUND", `action not found: ${actionId}`);
        }
        if (row.status === "committed") {
          return { status: "committed", receipt: storedReceipt(row) };
        }
        if (row.status === "rejected") {
          throw new AuthorityError(
            "E_NOT_HELD",
            `action was rejected: ${row.decision?.reason ?? "no reason recorded"}`,
          );
        }
        if (row.status === "expired" || isExpired(row)) {
          await tx.query(
            "update cg_actions set status = 'expired', updated_at = now() where id = $1",
            [row.id],
          );
          await insertEvent(tx, row.id, "expired", {});
          throw new AuthorityError("E_HOLD_EXPIRED", `hold expired for action ${actionId}`);
        }

        const action = actionFor(row.action_type);
        let result: unknown;
        try {
          result = await action.apply(context(tx, row), row.payload);
        } catch (error) {
          if (error instanceof ActionRejected) {
            await rejectRow(tx, row.id, {
              reason: error.reason,
              ...(error.alternatives ? { alternatives: error.alternatives } : {}),
            });
            return {
              status: "rejected",
              reason: error.reason,
              ...(error.alternatives ? { alternatives: error.alternatives } : {}),
            };
          }
          throw error;
        }

        const receipt: Receipt = {
          actionId: row.id,
          actionType: row.action_type,
          idempotencyKey: row.idempotency_key,
          committedAt: new Date().toISOString(),
          result,
        };
        await tx.query(
          "update cg_actions set status = 'committed', receipt = $2::jsonb, updated_at = now() where id = $1",
          [row.id, JSON.stringify(receipt)],
        );
        await insertEvent(tx, row.id, "committed", {});
        return { status: "committed", receipt };
      });
    },

    async get(idempotencyKey) {
      const rows = await options.db.query<ActionRow>(
        "select * from cg_actions where scope = $1 and idempotency_key = $2",
        [scope, idempotencyKey],
      );
      const row = rows[0];
      return row ? toRecord(row) : null;
    },
  };
}

function context(tx: Client, row: ActionRow): TxContext {
  return {
    tx,
    scope: row.scope,
    actionId: row.id,
    actionType: row.action_type,
    idempotencyKey: row.idempotency_key,
  };
}

async function insertEvent(
  tx: Client,
  actionId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  await tx.query("insert into cg_events (action_id, event, data) values ($1, $2, $3::jsonb)", [
    actionId,
    event,
    JSON.stringify(data),
  ]);
}

async function rejectRow(
  tx: Client,
  actionId: string,
  decision: { reason: string; alternatives?: readonly unknown[] },
): Promise<void> {
  const payload =
    decision.alternatives === undefined
      ? { reason: decision.reason }
      : { reason: decision.reason, alternatives: decision.alternatives };
  await tx.query(
    "update cg_actions set status = 'rejected', decision = $2::jsonb, updated_at = now() where id = $1",
    [actionId, JSON.stringify(payload)],
  );
  await insertEvent(tx, actionId, "rejected", payload);
}

function rejectedProposal(decision: {
  reason: string;
  alternatives?: readonly unknown[];
}): Proposal {
  return decision.alternatives === undefined
    ? { status: "rejected", reason: decision.reason }
    : { status: "rejected", reason: decision.reason, alternatives: decision.alternatives };
}

function storedReceipt(row: ActionRow): Receipt {
  if (!row.receipt) {
    throw new Error("exactly-once: invariant violated, committed action without receipt");
  }
  return row.receipt;
}

function isExpired(row: ActionRow): boolean {
  return row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now();
}

function toIso(value: Date | string | null): string {
  if (value === null) {
    throw new Error("exactly-once: invariant violated, expected a timestamp");
  }
  return value instanceof Date ? value.toISOString() : value;
}

function toRecord(row: ActionRow): ActionRecord {
  return {
    id: row.id,
    actionType: row.action_type,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
    receipt: row.receipt,
    reason: row.decision?.reason ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Stable JSON serialization for payload comparison (key order and undefined-proof). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([entryKey, entryValue]) => `${JSON.stringify(entryKey)}:${canonical(entryValue)}`)
    .join(",")}}`;
}
