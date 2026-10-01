import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ActionRecord,
  type Authority,
  AuthorityError,
  type CommitResult,
  type Proposal,
} from "../../src/index.js";
import { createMcpServer } from "../../src/mcp.js";

const RECEIPT = {
  actionId: "action-1",
  actionType: "createBooking",
  idempotencyKey: "wa-msg-8821",
  committedAt: "2026-10-01T00:00:00.000Z",
  result: { slot: "sat-1500" },
};

function stubAuthority(overrides: Partial<Authority> = {}): Authority {
  return {
    migrate: vi.fn(async () => {}),
    propose: vi.fn(
      async (): Promise<Proposal> => ({
        status: "approved",
        actionId: "action-1",
        expiresAt: "2026-10-01T00:05:00.000Z",
      }),
    ),
    commit: vi.fn(async (): Promise<CommitResult> => ({ status: "committed", receipt: RECEIPT })),
    get: vi.fn(async (): Promise<ActionRecord | null> => null),
    ...overrides,
  };
}

interface Harness {
  client: Client;
  close: () => Promise<void>;
}

let harness: Harness | undefined;

async function connect(authority: Authority): Promise<Harness> {
  const server = createMcpServer({ authority });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  harness = {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function textOf(result: { content: unknown }): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("");
}

describe("mcp server", () => {
  it("exposes the three protocol tools", async () => {
    await connect(stubAuthority());
    const tools = await harness?.client.listTools();
    const names = tools?.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["commit_action", "get_action", "propose_action"]);
  });

  it("propose_action returns the proposal as JSON", async () => {
    const authority = stubAuthority();
    await connect(authority);

    const result = await harness?.client.callTool({
      name: "propose_action",
      arguments: {
        actionType: "createBooking",
        payload: { slot: "sat-1500" },
        idempotencyKey: "k1",
      },
    });

    expect(result?.isError).toBeFalsy();
    expect(JSON.parse(textOf(result as { content: unknown }))).toEqual({
      status: "approved",
      actionId: "action-1",
      expiresAt: "2026-10-01T00:05:00.000Z",
    });
    expect(authority.propose).toHaveBeenCalledWith(
      "createBooking",
      { slot: "sat-1500" },
      { idempotencyKey: "k1" },
    );
  });

  it("propose_action flows rejections with alternatives through", async () => {
    const authority = stubAuthority({
      propose: async (): Promise<Proposal> => ({
        status: "rejected",
        reason: "slot_taken",
        alternatives: ["sat-1600", "sun-0900"],
      }),
    });
    await connect(authority);

    const result = await harness?.client.callTool({
      name: "propose_action",
      arguments: { actionType: "createBooking", payload: {}, idempotencyKey: "k2" },
    });

    expect(result?.isError).toBeFalsy();
    expect(JSON.parse(textOf(result as { content: unknown }))).toEqual({
      status: "rejected",
      reason: "slot_taken",
      alternatives: ["sat-1600", "sun-0900"],
    });
  });

  it("propose_action surfaces AuthorityError as isError with its code", async () => {
    const authority = stubAuthority({
      propose: async (): Promise<Proposal> => {
        throw new AuthorityError("E_ACTION_UNKNOWN", 'unknown action type: "nope"');
      },
    });
    await connect(authority);

    const result = await harness?.client.callTool({
      name: "propose_action",
      arguments: { actionType: "nope", payload: {}, idempotencyKey: "k3" },
    });

    expect(result?.isError).toBe(true);
    expect(JSON.parse(textOf(result as { content: unknown }))).toEqual({
      error: { code: "E_ACTION_UNKNOWN", message: 'unknown action type: "nope"' },
    });
  });

  it("commit_action returns the receipt", async () => {
    const authority = stubAuthority();
    await connect(authority);

    const result = await harness?.client.callTool({
      name: "commit_action",
      arguments: { actionId: "action-1" },
    });

    expect(result?.isError).toBeFalsy();
    expect(JSON.parse(textOf(result as { content: unknown }))).toEqual({
      status: "committed",
      receipt: RECEIPT,
    });
    expect(authority.commit).toHaveBeenCalledWith("action-1");
  });

  it("get_action returns null when the key is unknown and never executes anything", async () => {
    const authority = stubAuthority();
    await connect(authority);

    const result = await harness?.client.callTool({
      name: "get_action",
      arguments: { idempotencyKey: "missing" },
    });

    expect(result?.isError).toBeFalsy();
    expect(JSON.parse(textOf(result as { content: unknown }))).toBeNull();
    expect(authority.propose).not.toHaveBeenCalled();
    expect(authority.commit).not.toHaveBeenCalled();
  });
});
