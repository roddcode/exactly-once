import { describe, expect, it } from "vitest";
import {
  fromPg,
  type PgClient,
  PgCommitUnknownError,
  type PgPool,
  type PgQueryResult,
} from "../../src/index.js";

type QueryHandler = (sql: string, client: FakeClient) => Promise<PgQueryResult<unknown>>;

class FakeClient implements PgClient {
  readonly queries: string[] = [];
  readonly releases: Array<Error | undefined> = [];
  private readonly listeners = new Set<(error: Error) => void>();

  constructor(private readonly handler: QueryHandler) {}

  get listenerCount(): number {
    return this.listeners.size;
  }

  on(event: "error", listener: (error: Error) => void): void {
    if (event === "error") this.listeners.add(listener);
  }

  off(event: "error", listener: (error: Error) => void): void {
    if (event === "error") this.listeners.delete(listener);
  }

  emitError(error: Error): void {
    if (this.listeners.size === 0) throw error;
    for (const listener of [...this.listeners]) listener(error);
  }

  release(error?: Error): void {
    this.releases.push(error);
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<R>> {
    this.queries.push(sql);
    const result = await this.handler(sql, this);
    // The test handler does not inspect values; keep the parameter part of the
    // structural contract.
    void values;
    return result as PgQueryResult<R>;
  }
}

class FakePool implements PgPool {
  constructor(private readonly client: FakeClient) {}

  async connect(): Promise<PgClient> {
    return this.client;
  }

  async query<R = Record<string, unknown>>(): Promise<PgQueryResult<R>> {
    return { rows: [] };
  }
}

function connectionError(code: string, message = "connection failure"): Error {
  return Object.assign(new Error(message), { code });
}

describe("fromPg transaction resilience", () => {
  it("attaches an error listener, rolls back, and releases a broken client once", async () => {
    const failure = connectionError("ECONNRESET", "connection terminated");
    const client = new FakeClient(async (sql, current) => {
      if (sql === "begin" || sql === "rollback") return { rows: [] };
      if (sql === "select fail") {
        current.emitError(failure);
        throw failure;
      }
      return { rows: [] };
    });
    const db = fromPg(new FakePool(client));

    await expect(
      db.transaction(async (tx) => {
        expect(client.listenerCount).toBe(1);
        await tx.query("select fail");
      }),
    ).rejects.toBe(failure);

    expect(client.queries).toEqual(["begin", "select fail", "rollback"]);
    expect(client.releases).toEqual([failure]);
    expect(client.listenerCount).toBe(0);
  });

  it("keeps 40P01 and 40001 errors intact for consumer retry policies", async () => {
    for (const code of ["40P01", "40001"]) {
      const failure = connectionError(code, `postgres ${code}`);
      const client = new FakeClient(async (sql) => {
        if (sql === "commit") throw failure;
        return { rows: [] };
      });
      const db = fromPg(new FakePool(client));

      await expect(db.transaction(async (tx) => tx.query("select 1"))).rejects.toBe(failure);

      expect(failure).toMatchObject({ code });
      expect(client.releases).toEqual([undefined]);
      expect(client.listenerCount).toBe(0);
    }
  });

  it("marks a COMMIT transport failure as an unknown outcome and discards the client", async () => {
    const failure = new Error("socket closed during COMMIT");
    const client = new FakeClient(async (sql) => {
      if (sql === "commit") throw failure;
      if (sql === "rollback") throw connectionError("ECONNRESET", "rollback failed");
      return { rows: [] };
    });
    const db = fromPg(new FakePool(client));

    const error = await db
      .transaction(async (tx) => tx.query("select 1"))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PgCommitUnknownError);
    expect(error).toMatchObject({ code: undefined, outcome: "unknown", cause: failure });
    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]).toBe(error);
    expect(client.listenerCount).toBe(0);
  });

  it("marks a COMMIT connection failure with SQLSTATE 57P01 as unknown", async () => {
    const failure = connectionError("57P01", "terminating connection");
    const client = new FakeClient(async (sql) => {
      if (sql === "commit") throw failure;
      if (sql === "rollback") throw failure;
      return { rows: [] };
    });
    const db = fromPg(new FakePool(client));

    const error = await db
      .transaction(async (tx) => tx.query("select 1"))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PgCommitUnknownError);
    expect(error).toMatchObject({ code: "57P01", outcome: "unknown" });
    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]).toBe(error);
    expect(client.listenerCount).toBe(0);
  });

  it("does not accumulate listeners or release a healthy client twice", async () => {
    const client = new FakeClient(async () => ({ rows: [] }));
    const db = fromPg(new FakePool(client));

    await db.transaction(async (tx) => tx.query("select 1"));
    await db.transaction(async (tx) => tx.query("select 2"));

    expect(client.queries).toEqual(["begin", "select 1", "commit", "begin", "select 2", "commit"]);
    expect(client.releases).toEqual([undefined, undefined]);
    expect(client.listenerCount).toBe(0);
  });

  it("discards a client that emitted an error even when the query resolved", async () => {
    const failure = connectionError("ECONNRESET", "socket closed");
    const client = new FakeClient(async (sql, current) => {
      if (sql === "select") {
        current.emitError(failure);
      }
      return { rows: [] };
    });
    const db = fromPg(new FakePool(client));

    await expect(db.transaction(async (tx) => tx.query("select"))).resolves.toEqual([]);

    expect(client.releases).toEqual([failure]);
    expect(client.listenerCount).toBe(0);
  });

  it("releases once when rollback also fails after a query error", async () => {
    const failure = connectionError("ECONNRESET", "query connection lost");
    const rollbackFailure = connectionError("ECONNRESET", "rollback connection lost");
    const client = new FakeClient(async (sql) => {
      if (sql === "rollback") throw rollbackFailure;
      if (sql === "select fail") throw failure;
      return { rows: [] };
    });
    const db = fromPg(new FakePool(client));

    await expect(db.transaction(async (tx) => tx.query("select fail"))).rejects.toBe(failure);

    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]).toBe(failure);
    expect(client.listenerCount).toBe(0);
  });
});
