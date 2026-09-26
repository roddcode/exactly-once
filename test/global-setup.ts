import { Pool } from "pg";

/**
 * Database tests need a real PostgreSQL, in this order of preference:
 *   1. TEST_DATABASE_URL (CI service or any explicit database)
 *   2. the docker compose database on localhost:5433 (`pnpm db:up`)
 */

const DEFAULT_URL = "postgres://exactly_once:exactly_once@localhost:5433/exactly_once";

export async function setup(): Promise<void> {
  if (process.env.TEST_DATABASE_URL) {
    return;
  }
  if (await isReachable(DEFAULT_URL)) {
    process.env.TEST_DATABASE_URL = DEFAULT_URL;
    return;
  }
  throw new Error(
    `Postgres is not reachable at ${DEFAULT_URL}. Start it with "pnpm db:up" or set TEST_DATABASE_URL.`,
  );
}

async function isReachable(url: string): Promise<boolean> {
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1500, max: 1 });
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
