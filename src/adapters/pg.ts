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
  release(error?: Error): void;
  on?(event: "error", listener: (error: Error) => void): void;
  off?(event: "error", listener: (error: Error) => void): void;
  removeListener?(event: "error", listener: (error: Error) => void): void;
}

export interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>;
}

/**
 * A COMMIT was sent but the connection failed before PostgreSQL's response was
 * received. The transaction may have committed or rolled back. Reconcile with
 * `commit(actionId)` or `propose` using the same idempotency key; do not assume
 * rollback.
 */
export class PgCommitUnknownError extends Error {
  readonly code: string | undefined;
  readonly outcome = "unknown" as const;

  constructor(cause: unknown) {
    super(
      "PostgreSQL COMMIT outcome is unknown; reconcile with commit(actionId) or propose using the same idempotency key.",
      { cause },
    );
    this.name = "PgCommitUnknownError";
    this.code = errorCode(cause);
  }
}

const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isConnectionFailure(error: unknown): boolean {
  const code = errorCode(error);
  if (code === undefined) return false;
  return (
    code.startsWith("08") ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03" ||
    CONNECTION_ERROR_CODES.has(code)
  );
}

function isAmbiguousCommitError(error: unknown): boolean {
  const code = errorCode(error);
  // A COMMIT error without a PostgreSQL SQLSTATE is a transport failure.
  return code === undefined || isConnectionFailure(error);
}

function asError(error: unknown): Error | undefined {
  return error instanceof Error ? error : undefined;
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

      let broken: Error | undefined;
      let releaseError: Error | undefined;
      let released = false;

      const onError = (error: Error) => {
        broken ??= error;
      };
      const detach = () => {
        if (connection.off) {
          connection.off("error", onError);
        } else {
          connection.removeListener?.("error", onError);
        }
      };
      const release = (error?: Error) => {
        if (released) return;
        released = true;
        detach();
        if (error) {
          connection.release(error);
        } else {
          connection.release();
        }
      };

      connection.on?.("error", onError);

      try {
        await connection.query("begin");
        const result = await fn(tx);
        try {
          await connection.query("commit");
        } catch (error) {
          if (isAmbiguousCommitError(error)) {
            const ambiguous = new PgCommitUnknownError(error);
            releaseError = ambiguous;
            throw ambiguous;
          }
          throw error;
        }
        return result;
      } catch (error) {
        let rollbackError: unknown;
        try {
          await connection.query("rollback");
        } catch (caught) {
          rollbackError = caught;
        }

        if (releaseError === undefined) {
          if (broken) {
            releaseError = broken;
          } else if (isConnectionFailure(error)) {
            releaseError = asError(error);
          } else if (isConnectionFailure(rollbackError)) {
            releaseError = asError(rollbackError);
          }
        }
        throw error;
      } finally {
        release(releaseError ?? broken);
      }
    },
  };
}
