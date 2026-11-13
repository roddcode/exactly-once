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
  /** Default hold TTL in seconds when an action does not declare one. Must be a finite positive number. Default: 300. */
  readonly defaultHoldTtlSeconds?: number;
}

const DEFAULT_HOLD_TTL_SECONDS = 300;
const MAX_KEY_LENGTH = 255;

function assertTtl(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`exactly-once: ${label} must be a finite positive number of seconds`);
  }
}

function resolveTtl(value: number | undefined, fallback: number, label: string): number {
  const ttl = value === undefined ? fallback : value;
  assertTtl(ttl, label);
  return ttl;
}

type SavepointMode = "always-rollback" | "release-on-success";

let savepointSequence = 0;

function nextSavepoint(kind: "validate" | "apply"): string {
  savepointSequence += 1;
  return `exactly_once_${kind}_${savepointSequence}`;
}

/**
 * Run a domain callback inside a savepoint.
 *
 * `validate` is logically read-only: its savepoint is always rolled back, so
 * no domain write survives the proposal. `apply` keeps its writes on success
 * and rolls back to the savepoint when it throws (notably `ActionRejected`).
 *
 * Savepoints undo transactional database writes. They do not undo sequence
 * advances, external effects, or session-level side effects; callbacks must
 * not rely on those inside `validate`.
 */
async function inSavepoint<T>(
  tx: Client,
  name: string,
  mode: SavepointMode,
  fn: () => T | Promise<T>,
): Promise<T> {
  await tx.query(`savepoint ${name}`);
  try {
    const result = await fn();
    if (mode === "always-rollback") {
      await tx.query(`rollback to savepoint ${name}`);
    }
    await tx.query(`release savepoint ${name}`);
    return result;
  } catch (error) {
    try {
      await tx.query(`rollback to savepoint ${name}`);
    } catch {
      // The connection is broken; the original error is the one that matters.
    }
    throw error;
  }
}

type JsonErrorCode = "E_INVALID_PAYLOAD" | "E_INVALID_RESULT";

function serializeJson(value: unknown, label: string, code: JsonErrorCode): string {
  assertJsonValue(value, label, new Set(), code);
  return JSON.stringify(value);
}

function assertJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  code: JsonErrorCode,
): void {
  if (value === null) return;

  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new AuthorityError(code, `${path} must be a finite number`);
      }
      return;
    case "undefined":
      throw new AuthorityError(code, `${path} is undefined; omit the property instead`);
    case "bigint":
      throw new AuthorityError(code, `${path} is a BigInt; use a JSON-compatible value`);
    case "function":
    case "symbol":
      throw new AuthorityError(code, `${path} is a ${typeof value}; use a JSON-compatible value`);
    case "object":
      break;
  }

  const object = value as object;
  if (ancestors.has(object)) {
    throw new AuthorityError(code, `${path} contains a circular reference`);
  }
  ancestors.add(object);

  try {
    if (Object.getOwnPropertySymbols(object).length > 0) {
      throw new AuthorityError(code, `${path} has symbol-keyed properties`);
    }

    if (Array.isArray(value)) {
      for (const key of Object.getOwnPropertyNames(value)) {
        if (key === "length") continue;
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          throw new AuthorityError(code, `${path}.${key} is not a valid array index`);
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new AuthorityError(code, `${path}[${index}] is a hole`);
        }
        assertJsonValue(value[index], `${path}[${index}]`, ancestors, code);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AuthorityError(code, `${path} is not a plain object`);
    }

    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if (!descriptor.enumerable) {
        throw new AuthorityError(code, `${path}.${key} is not enumerable`);
      }
      if (!("value" in descriptor)) {
        throw new AuthorityError(code, `${path}.${key} is an accessor`);
      }
      assertJsonValue(descriptor.value, `${path}.${key}`, ancestors, code);
    }
  } finally {
    ancestors.delete(object);
  }
}

export function createAuthority(options: AuthorityOptions): Authority {
  const scope = options.scope ?? "default";
  const defaultTtl = resolveTtl(
    options.defaultHoldTtlSeconds,
    DEFAULT_HOLD_TTL_SECONDS,
    "defaultHoldTtlSeconds",
  );
  const registry = new Map<string, ErasedAction>();

  for (const action of options.actions) {
    if (!action.type.trim()) {
      throw new Error("exactly-once: action type must be a non-empty string");
    }
    if (registry.has(action.type)) {
      throw new Error(`exactly-once: duplicate action type "${action.type}"`);
    }
    const actionTtl = action.hold?.ttlSeconds;
    if (actionTtl !== undefined) {
      assertTtl(actionTtl, `action "${action.type}" hold.ttlSeconds`);
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
      const ttlSeconds = resolveTtl(
        action.hold?.ttlSeconds,
        defaultTtl,
        `action "${action.type}" hold.ttlSeconds`,
      );
      const payloadJson = serializeJson(payload, "payload", "E_INVALID_PAYLOAD");

      return options.db.transaction(async (tx) => {
        const inserted = await tx.query<ActionRow>(
          `insert into cg_actions (scope, action_type, idempotency_key, status, payload, expires_at)
           values ($1, $2, $3, 'held', $4::jsonb, null)
           on conflict (scope, idempotency_key) do nothing
           returning *`,
          [scope, actionType, key, payloadJson],
        );

        const created = inserted[0];
        if (created) {
          await insertEventJson(tx, created.id, "held", `{"payload":${payloadJson}}`);
          const validate = action.validate;
          const decision = validate
            ? await inSavepoint(tx, nextSavepoint("validate"), "always-rollback", () =>
                validate(context(tx, created), payload),
              )
            : null;
          if (decision && !decision.allow) {
            await rejectRow(tx, created.id, decision);
            return rejectedProposal(decision);
          }
          const approved = await setHoldExpiry(tx, created.id, ttlSeconds);
          return {
            status: "approved",
            actionId: approved.id,
            expiresAt: toIso(approved.expires_at),
          };
        }

        const existing = await tx.query<ActionRow & { payload_matches: boolean }>(
          `select *, payload = $3::jsonb as payload_matches
           from cg_actions
           where scope = $1 and idempotency_key = $2
           for update`,
          [scope, key, payloadJson],
        );
        const row = existing[0];
        if (!row) {
          throw new Error(
            "exactly-once: invariant violated, conflicted insert without a persisted row",
          );
        }
        if (row.action_type !== actionType) {
          throw new AuthorityError(
            "E_IDEMPOTENCY_MISMATCH",
            `idempotency key "${key}" is already bound to action type "${row.action_type}"`,
          );
        }
        if (!row.payload_matches) {
          throw new AuthorityError(
            "E_IDEMPOTENCY_MISMATCH",
            `idempotency key "${key}" was already used with a different payload`,
          );
        }
        if (row.status === "committed") {
          return { status: "committed", receipt: storedReceipt(row) };
        }
        const expired =
          row.status === "expired" || (row.status === "held" && (await isHoldExpired(tx, row.id)));
        if (row.status === "held" && !expired) {
          return { status: "approved", actionId: row.id, expiresAt: toIso(row.expires_at) };
        }

        const validate = action.validate;
        const decision = validate
          ? await inSavepoint(tx, nextSavepoint("validate"), "always-rollback", () =>
              validate(context(tx, row), payload),
            )
          : null;
        if (decision && !decision.allow) {
          await rejectRow(tx, row.id, decision);
          return rejectedProposal(decision);
        }
        const revived = await tx.query<ActionRow>(
          `update cg_actions
           set status = 'held', decision = null, receipt = null,
               expires_at = clock_timestamp() + make_interval(secs => $2),
               updated_at = clock_timestamp()
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
      const outcome = await options.db.transaction(async (tx) => {
        const found = await tx.query<ActionRow>(
          "select * from cg_actions where id = $1 and scope = $2 for update",
          [actionId, scope],
        );
        const row = found[0];
        if (!row) {
          throw new AuthorityError("E_NOT_FOUND", `action not found: ${actionId}`);
        }
        if (row.status === "committed") {
          return { status: "committed" as const, receipt: storedReceipt(row) };
        }
        if (row.status === "rejected") {
          throw new AuthorityError(
            "E_NOT_HELD",
            `action was rejected: ${row.decision?.reason ?? "no reason recorded"}`,
          );
        }
        const expired =
          row.status === "expired" || (row.status === "held" && (await isHoldExpired(tx, row.id)));
        if (expired) {
          await markExpired(tx, row.id);
          return null;
        }

        const action = actionFor(row.action_type);
        let result: unknown;
        try {
          result = await inSavepoint(tx, nextSavepoint("apply"), "release-on-success", () =>
            action.apply(context(tx, row), row.payload),
          );
        } catch (error) {
          if (error instanceof ActionRejected) {
            await rejectRow(tx, row.id, {
              reason: error.reason,
              ...(error.alternatives ? { alternatives: error.alternatives } : {}),
            });
            return {
              status: "rejected" as const,
              reason: error.reason,
              ...(error.alternatives ? { alternatives: error.alternatives } : {}),
            };
          }
          throw error;
        }

        const resultValue = result === undefined ? null : result;
        serializeJson(resultValue, "result", "E_INVALID_RESULT");
        const receipt: Receipt = {
          actionId: row.id,
          actionType: row.action_type,
          idempotencyKey: row.idempotency_key,
          committedAt: new Date().toISOString(),
          result: resultValue,
        };
        const updated = await tx.query<ActionRow>(
          "update cg_actions set status = 'committed', receipt = $2::jsonb, updated_at = clock_timestamp() where id = $1 returning *",
          [row.id, JSON.stringify(receipt)],
        );
        const stored = updated[0];
        if (!stored) {
          throw new Error("exactly-once: invariant violated, commit update returned no row");
        }
        await insertEvent(tx, row.id, "committed", {});
        return { status: "committed" as const, receipt: storedReceipt(stored) };
      });

      if (outcome === null) {
        throw new AuthorityError("E_HOLD_EXPIRED", `hold expired for action ${actionId}`);
      }
      return outcome;
    },

    async get(idempotencyKey) {
      const rows = await options.db.query<ActionRow & { effective_expired: boolean }>(
        `select *,
                (status = 'held' and (expires_at is null or expires_at <= clock_timestamp()))
                  as effective_expired
         from cg_actions
         where scope = $1 and idempotency_key = $2`,
        [scope, idempotencyKey],
      );
      const row = rows[0];
      if (!row) return null;
      return toRecord(row, row.effective_expired ? "expired" : row.status);
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
  await insertEventJson(tx, actionId, event, JSON.stringify(data));
}

async function insertEventJson(
  tx: Client,
  actionId: string,
  event: string,
  dataJson: string,
): Promise<void> {
  await tx.query("insert into cg_events (action_id, event, data) values ($1, $2, $3::jsonb)", [
    actionId,
    event,
    dataJson,
  ]);
}

async function setHoldExpiry(tx: Client, actionId: string, ttlSeconds: number): Promise<ActionRow> {
  const rows = await tx.query<ActionRow>(
    `update cg_actions
     set expires_at = clock_timestamp() + make_interval(secs => $2),
         updated_at = clock_timestamp()
     where id = $1
     returning *`,
    [actionId, ttlSeconds],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("exactly-once: invariant violated, hold expiry update returned no row");
  }
  return row;
}

async function isHoldExpired(tx: Client, actionId: string): Promise<boolean> {
  const rows = await tx.query<{ expired: boolean }>(
    `select (expires_at is null or expires_at <= clock_timestamp()) as expired
     from cg_actions
     where id = $1`,
    [actionId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("exactly-once: invariant violated, expired check found no action");
  }
  return row.expired;
}

async function markExpired(tx: Client, actionId: string): Promise<void> {
  const rows = await tx.query<{ id: string }>(
    `update cg_actions
     set status = 'expired', updated_at = clock_timestamp()
     where id = $1 and status = 'held'
     returning id`,
    [actionId],
  );
  if (rows[0]) {
    await insertEvent(tx, actionId, "expired", {});
  }
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
    "update cg_actions set status = 'rejected', decision = $2::jsonb, updated_at = clock_timestamp() where id = $1",
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

function toIso(value: Date | string | null): string {
  if (value === null) {
    throw new Error("exactly-once: invariant violated, expected a timestamp");
  }
  return value instanceof Date ? value.toISOString() : value;
}

function toRecord(row: ActionRow, status: ActionStatus = row.status): ActionRecord {
  return {
    id: row.id,
    actionType: row.action_type,
    idempotencyKey: row.idempotency_key,
    status,
    expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
    receipt: row.receipt,
    reason: row.decision?.reason ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}
