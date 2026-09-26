import type { Client, Database } from "../types.js";

/** Structural subset of a pg result. */
export interface PgQueryResult<R> {
  readonly rows: R[];
}

/** Structural subset of `pg.Pool` / `pg.Client`. `pg.Pool` satisfies it as-is. */
export interface PgQueryable {
  query<R = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<R>>;
}

export interface PgClient extends PgQueryable {
  release(): void;
}

export interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>;
}

/**
 * Adapt a `pg` pool (or anything structurally equivalent) to the authority's
 * `Database` interface. Zero runtime dependencies: `pg` stays a devDependency.
 *
 * ```ts
 * import { Pool } from "pg";
 * const authority = createAuthority({ db: fromPg(new Pool({ connectionString })), actions: [...] });
 * ```
 */
export function fromPg(pool: PgPool): Database {
  return {
    async query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const result = await pool.query<R>(sql, params === undefined ? undefined : [...params]);
      return result.rows;
    },

    async transaction(fn) {
      const connection = await pool.connect();
      const tx: Client = {
        async query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
          const result = await connection.query<R>(
            sql,
            params === undefined ? undefined : [...params],
          );
          return result.rows;
        },
      };
      try {
        await connection.query("begin");
        const result = await fn(tx);
        await connection.query("commit");
        return result;
      } catch (error) {
        try {
          await connection.query("rollback");
        } catch {
          // The connection is broken; the original error is the one that matters.
        }
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}
