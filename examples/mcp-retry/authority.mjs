import { ActionRejected, createAuthority, defineAction, fromPg } from "exactly-once";
import pg from "pg";

const { Pool } = pg;

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  "postgres://exactly_once:exactly_once@localhost:5433/exactly_once";

export const SCOPE = "mcp-retry-example";
export const IDEMPOTENCY_KEY = "booking-123";
export const SLOT = "sat-1500";

const createBooking = defineAction({
  type: "createBooking",
  hold: { ttlSeconds: 300 },
  validate: async (ctx, payload) => {
    const rows = await ctx.tx.query(
      "select 1 from demo_slots where id = $1 and booking_id is null",
      [payload.slot],
    );
    return rows.length > 0 ? { allow: true } : { allow: false, reason: "slot_taken" };
  },
  apply: async (ctx, payload) => {
    // The conditional update re-checks the slot inside the commit transaction.
    // If another action took it after our hold, zero rows update and the
    // commit is rejected instead of double-booking.
    const updated = await ctx.tx.query(
      "update demo_slots set booking_id = $1 where id = $2 and booking_id is null returning id",
      [ctx.idempotencyKey, payload.slot],
    );
    if (updated.length === 0) {
      throw new ActionRejected("slot_taken");
    }
    return { slot: payload.slot };
  },
});

export async function createExampleAuthority() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const authority = createAuthority({
    db: fromPg(pool),
    scope: SCOPE,
    actions: [createBooking],
  });
  await pool.query("create table if not exists demo_slots (id text primary key, booking_id text)");
  await authority.migrate();
  return { authority, pool };
}

export async function resetExample(pool) {
  await pool.query("truncate table demo_slots");
  await pool.query("delete from cg_actions where scope = $1", [SCOPE]);
  await pool.query("insert into demo_slots (id) values ($1)", [SLOT]);
}
