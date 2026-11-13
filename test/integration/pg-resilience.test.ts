import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAuthority,
  type Database,
  defineAction,
  fromPg,
  PgCommitUnknownError,
} from "../../src/index.js";
import { DEFAULT_TEST_DATABASE_URL, openTestDatabase, type TestDb } from "../helpers/db.js";

const TEST_URL = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
const VICTIM_APP = "exactly-once-eo005-victim";

interface NotePayload {
  readonly note: string;
}

const slowWrite = defineAction<NotePayload, { ok: true }>({
  type: "slowWrite",
  hold: { ttlSeconds: 60 },
  apply: async (ctx, payload) => {
    await ctx.tx.query("insert into resilience_domain (note) values ($1)", [payload.note]);
    await ctx.tx.query("select pg_sleep(1.5)");
    return { ok: true };
  },
});

const countedWrite = defineAction<NotePayload, { ok: true }>({
  type: "countedWrite",
  hold: { ttlSeconds: 60 },
  apply: async (ctx, payload) => {
    await ctx.tx.query("insert into resilience_domain (note) values ($1)", [payload.note]);
    return { ok: true };
  },
});

describe("PostgreSQL adapter resilience", () => {
  let database: TestDb;

  beforeAll(async () => {
    database = await openTestDatabase();
    await database.db.query(
      "create table if not exists resilience_domain (id serial primary key, note text)",
    );
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await database.reset(["resilience", "resilience-loss"]);
    await database.db.query("truncate table resilience_domain restart identity");
  });

  async function domainNotes(): Promise<string[]> {
    const rows = await database.db.query<{ note: string }>(
      "select note from resilience_domain order by id",
    );
    return rows.map((row) => row.note);
  }

  async function terminateActiveBackend(appName: string): Promise<boolean> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const rows = await database.db.query<{ killed: boolean }>(
        "select pg_terminate_backend(pid) as killed from pg_stat_activity where application_name = $1 and state = 'active'",
        [appName],
      );
      if (rows.some((row) => row.killed)) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  it("survives a terminated backend during apply, discards the client, and retries", async () => {
    const victimPool = new Pool({
      connectionString: TEST_URL,
      max: 1,
      application_name: VICTIM_APP,
    });
    victimPool.on("error", () => {
      // The pool may emit for idle clients; the checked-out client is handled
      // by fromPg. This listener only keeps the test process alive.
    });
    const victimAuthority = createAuthority({
      db: fromPg(victimPool),
      scope: "resilience",
      actions: [slowWrite],
    });

    try {
      const proposed = await victimAuthority.propose(
        "slowWrite",
        { note: "crash" },
        { idempotencyKey: "crash" },
      );
      if (proposed.status !== "approved") throw new Error("expected approved");

      const commitPromise = victimAuthority.commit(proposed.actionId).then(
        () => ({ ok: true as const }),
        (error: { code?: string; message?: string }) => ({
          ok: false as const,
          code: error.code,
          message: error.message,
        }),
      );

      expect(await terminateActiveBackend(VICTIM_APP)).toBe(true);

      const outcome = await commitPromise;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect([undefined, "57P01", "ECONNRESET"]).toContain(outcome.code);
      }
      expect(await domainNotes()).toEqual([]);

      // A broken client must be destroyed, not returned to the pool as healthy.
      // Check before any read that would acquire a fresh connection.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(victimPool.totalCount).toBe(0);
      expect((await victimAuthority.get("crash"))?.status).toBe("held");

      const retried = await victimAuthority.commit(proposed.actionId);
      expect(retried.status).toBe("committed");
      expect(await domainNotes()).toEqual(["crash"]);
    } finally {
      await victimPool.end().catch(() => undefined);
    }
  });

  it("recovers a persisted receipt after a simulated lost COMMIT response", async () => {
    const normalAuthority = createAuthority({
      db: database.db,
      scope: "resilience-loss",
      actions: [countedWrite],
    });
    let loseCommitResponse = false;
    const lossyDb: Database = {
      query: database.db.query.bind(database.db),
      async transaction(fn) {
        const result = await database.db.transaction(fn);
        if (loseCommitResponse) {
          loseCommitResponse = false;
          throw new PgCommitUnknownError(new Error("simulated COMMIT response loss"));
        }
        return result;
      },
    };
    const lossyAuthority = createAuthority({
      db: lossyDb,
      scope: "resilience-loss",
      actions: [countedWrite],
    });

    const proposed = await normalAuthority.propose(
      "countedWrite",
      { note: "ambiguous" },
      { idempotencyKey: "ambiguous" },
    );
    if (proposed.status !== "approved") throw new Error("expected approved");

    loseCommitResponse = true;
    await expect(lossyAuthority.commit(proposed.actionId)).rejects.toBeInstanceOf(
      PgCommitUnknownError,
    );

    expect((await normalAuthority.get("ambiguous"))?.status).toBe("committed");
    expect(await domainNotes()).toEqual(["ambiguous"]);

    const replay = await normalAuthority.commit(proposed.actionId);
    expect(replay.status).toBe("committed");
    expect(await domainNotes()).toEqual(["ambiguous"]);
  });
});
