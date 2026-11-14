# Error reference

Two kinds of failure exist: operational errors the authority raises, and domain rejections you raise yourself.

## AuthorityError

`propose` and `commit` throw `AuthorityError` for invalid usage or illegal state. Every instance carries a stable `code`, a human `message`, and optional `details`.

| Code | Raised by | When | What to do |
|---|---|---|---|
| `E_ACTION_UNKNOWN` | `propose`, `commit` | The action type is not registered in `createAuthority({ actions })`. | Register the action, or fix the type string. |
| `E_INVALID_KEY` | `propose` | `idempotencyKey` is missing, empty, not a string, or longer than 255 characters. | Pass a stable key: a message id, a job id. One key per logical action. |
| `E_INVALID_PAYLOAD` | `propose` | The payload contains a value that cannot be represented stably as JSON (`undefined`, `Date`, `BigInt`, `NaN`, `Infinity`, functions, symbols, circular references, class instances, accessors). | Send JSON-compatible values. Omit properties instead of setting them to `undefined`. |
| `E_INVALID_RESULT` | `commit` | `apply` returned a value that cannot be represented stably as JSON. | Return JSON-compatible data. A `void` result is stored as `null`. |
| `E_IDEMPOTENCY_MISMATCH` | `propose` | The key already exists with a different action type or payload, in any state including `committed`. | Your caller has a bug. Never reuse a key for a different intent. |
| `E_NOT_FOUND` | `commit` | No action exists with that id in this authority's scope. | Check the id and the scope. Maybe the transaction that created it was rolled back. |
| `E_HOLD_EXPIRED` | `commit` | The hold TTL elapsed before commit. The expired transition and event are persisted before the error is raised. | `propose` again with the same key and payload to revive it, then commit. Retrying `commit` is safe and does not duplicate the event. |
| `E_NOT_HELD` | `commit` | The action was rejected, either by `validate` or by an `ActionRejected` thrown in `apply`. | Read the reason via `get(key)` instead of retrying blindly. |

```ts
import { AuthorityError } from "exactly-once";

try {
  await authority.commit(actionId);
} catch (error) {
  if (error instanceof AuthorityError) {
    switch (error.code) {
      case "E_HOLD_EXPIRED":
        // Re-propose with the same key, then commit again.
        break;
      // ...
    }
  }
  throw error;
}
```

## ActionRejected

Not an error condition. Throw it inside `apply` to end the action as rejected with a domain reason:

```ts
import { ActionRejected } from "exactly-once";

apply: async (ctx, payload) => {
  const updated = await ctx.tx.query(
    "update slots set booking_key = $1 where id = $2 and booking_key is null returning id",
    [ctx.idempotencyKey, payload.slot],
  );
  if (updated.length === 0) throw new ActionRejected("slot_taken");
  return { slot: payload.slot };
};
```

`commit` resolves with `{ status: "rejected", reason, alternatives? }`, the writes made by `apply` since its savepoint are rolled back, and the rejection is recorded in the audit log. External effects performed by `apply` are not rolled back.

`validate` must be logically read-only. The authority runs it in a savepoint that is always rolled back, so persistent domain writes are discarded even when validation allows. This is not a security sandbox: sequence advances, external calls and session-level side effects are not undone. Keep domain effects in `apply`. The payload is a deep-frozen copy of the persisted JSON; mutation cannot change the decision, and in strict mode it throws.

## Postgres errors you may see

Under heavy write contention, PostgreSQL can abort a transaction with `deadlock_detected` (`40P01`) or `serialization_failure` (`40001`). That is normal database behavior, not a bug in the authority. Retry the whole call:

```ts
const RETRYABLE = new Set(["40P01", "40001"]);

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt >= attempts || code === undefined || !RETRYABLE.has(code)) throw error;
    }
  }
}
```

Retries are safe for both verbs: `propose` is idempotent by key, and `commit` replays the stored receipt. PostgreSQL codes `40P01` and `40001` are rethrown unchanged by `fromPg` so this policy still works.

## `PgCommitUnknownError`

`fromPg` throws this when `COMMIT` was sent but the connection failed before PostgreSQL's response was received. The original error is available as `cause`; a SQLSTATE, when present, is exposed as `code`. The `outcome` is `"unknown"`: do not assume rollback.

Reconcile by calling `commit(actionId)` again or `propose` with the same idempotency key and payload. If the commit succeeded, both return the persisted receipt; if it did not, the hold or expired state remains.

## Timeouts and dropped connections

An error before `COMMIT` rolls back the transaction. A connection failure while waiting for `COMMIT` is ambiguous; reconnect and reconcile using the key or action id. Never infer from a timeout that nothing committed.

## Invariant errors

Messages starting with `exactly-once: invariant violated` are never expected. They mean state that should be impossible, like a committed row without a receipt. If you see one, open an issue with the full message.
