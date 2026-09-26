# Error reference

Two kinds of failure exist: operational errors the authority raises, and domain rejections you raise yourself.

## AuthorityError

`propose` and `commit` throw `AuthorityError` for invalid usage or illegal state. Every instance carries a stable `code`, a human `message`, and optional `details`.

| Code | Raised by | When | What to do |
|---|---|---|---|
| `E_ACTION_UNKNOWN` | `propose`, `commit` | The action type is not registered in `createAuthority({ actions })`. | Register the action, or fix the type string. |
| `E_INVALID_KEY` | `propose` | `idempotencyKey` is missing, empty, not a string, or longer than 255 characters. | Pass a stable key: a message id, a job id. One key per logical action. |
| `E_IDEMPOTENCY_MISMATCH` | `propose` | The key already exists with a different payload (live hold, or an expired/rejected row). | Your caller has a bug. Never reuse a key for a different intent. |
| `E_NOT_FOUND` | `commit` | No action exists with that id. | Check the id. Maybe the transaction that created it was rolled back. |
| `E_HOLD_EXPIRED` | `commit` | The hold TTL elapsed before commit. | `propose` again with the same key and payload to revive it, then commit. |
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

`commit` resolves with `{ status: "rejected", reason, alternatives? }`, the effect rolls back, and the rejection is recorded in the audit log.

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

Retries are safe for both verbs: `propose` is idempotent by key, and `commit` replays the stored receipt.

## Timeouts and dropped connections

Each verb runs inside one transaction. If the connection drops mid-commit, PostgreSQL rolls back and nothing commits: reconnect and re-issue with the same idempotency key.

## Invariant errors

Messages starting with `exactly-once: invariant violated` are never expected. They mean state that should be impossible, like a committed row without a receipt. If you see one, open an issue with the full message.
