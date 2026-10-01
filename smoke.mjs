// Validates the built `exactly-once/mcp` subpath end to end:
// run `pnpm build` first, then `pnpm smoke:mcp`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { connectStdio, createMcpServer } from "./dist/mcp.mjs";

const authority = {
  migrate: async () => {},
  propose: async () => ({
    status: "approved",
    actionId: "a1",
    expiresAt: "2026-10-01T00:05:00.000Z",
  }),
  commit: async () => ({
    status: "committed",
    receipt: {
      actionId: "a1",
      actionType: "createBooking",
      idempotencyKey: "k1",
      committedAt: "2026-10-01T00:00:00.000Z",
      result: { slot: "s1" },
    },
  }),
  get: async () => null,
};

const server = createMcpServer({ authority });
const client = new Client({ name: "smoke", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

const tools = await client.listTools();
const propose = await client.callTool({
  name: "propose_action",
  arguments: { actionType: "createBooking", payload: { slot: "s1" }, idempotencyKey: "k1" },
});
const commit = await client.callTool({ name: "commit_action", arguments: { actionId: "a1" } });

console.log("tools:", tools.tools.map((tool) => tool.name).join(", "));
console.log("propose:", propose.content[0].text);
console.log("commit:", commit.content[0].text);
console.log("connectStdio is function:", typeof connectStdio === "function");

await client.close();
await server.close();
console.log("SMOKE OK");
