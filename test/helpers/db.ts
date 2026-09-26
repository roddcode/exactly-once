import { Pool } from "pg";
import { type Database, fromPg, migrate } from "../../src/index.js";

export const DEFAULT_TEST_DATABASE_URL =
  "postgres://exactly_once:exactly_once@localhost:5433/exactly_once";

export interface TestDb {
  readonly db: Database;
  /** Delete only the rows of the given scopes, so parallel files never fight over table locks. */
  reset(scopes: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export async function openTestDatabase(): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const pool = new Pool({ connectionString: url, max: 20 });

  try {
    await pool.query("select 1");
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw new Error(
      `Postgres is not reachable at ${url}. Start it with "pnpm db:up" (docker compose) or set TEST_DATABASE_URL.`,
      { cause: error },
    );
  }

  const db = fromPg(pool);
  await migrate(db);

  return {
    db,
    async reset(scopes: readonly string[]) {
      await db.query(
        "delete from cg_events where action_id in (select id from cg_actions where scope = any($1::text[]))",
        [scopes],
      );
      await db.query("delete from cg_actions where scope = any($1::text[])", [scopes]);
    },
    async close() {
      await pool.end();
    },
  };
}
