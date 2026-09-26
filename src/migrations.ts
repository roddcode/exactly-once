import type { Database } from "./types.js";

/**
 * Schema for the authority's own tables. Domain tables stay in the user's
 * migrations; the authority never reads them except through your `validate`
 * and `apply` callbacks.
 *
 * Requires PostgreSQL 13+ (`gen_random_uuid`, identity columns).
 */
export const SCHEMA_SQL = `
create table if not exists cg_actions (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  action_type text not null,
  idempotency_key text not null,
  status text not null default 'held',
  payload jsonb not null,
  decision jsonb,
  receipt jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cg_actions_scope_key_unique unique (scope, idempotency_key),
  constraint cg_actions_status_check check (status in ('held', 'committed', 'rejected', 'expired'))
);

create index if not exists cg_actions_scope_type_status_idx
  on cg_actions (scope, action_type, status);

create index if not exists cg_actions_live_holds_idx
  on cg_actions (expires_at)
  where status = 'held';

create table if not exists cg_events (
  id bigint generated always as identity primary key,
  action_id uuid not null references cg_actions(id) on delete cascade,
  event text not null,
  data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists cg_events_action_idx on cg_events (action_id);
`;

/** idempotent: safe to run on every boot. serialized with a transaction-scoped advisory lock. */
export async function migrate(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await tx.query(SCHEMA_SQL);
  });
}

/** ASCII "exac". */
const MIGRATION_LOCK_KEY = 0x65786163;
