import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Authority } from "./authority.js";
import { AuthorityError } from "./errors.js";

/**
 * Options for {@link createMcpServer}.
 *
 * The MCP adapter lives behind the `exactly-once/mcp` subpath so the core
 * package keeps zero runtime dependencies. Consumers of this subpath install
 * `@modelcontextprotocol/sdk` and `zod` themselves.
 */
export interface McpServerOptions {
  /** The authority whose protocol this server exposes. */
  readonly authority: Authority;
  /** Server name announced to MCP clients. Default: `"exactly-once"`. */
  readonly name?: string;
  /** Server version announced to MCP clients. Default: the library version. */
  readonly version?: string;
  /** Instructions sent to MCP clients. Defaults to the protocol workflow. */
  readonly instructions?: string;
}

export type { McpServer };

const DEFAULT_NAME = "exactly-once";
const DEFAULT_VERSION = "0.2.0";
const DEFAULT_INSTRUCTIONS = [
  "Agents propose. The database decides.",
  "Workflow: propose_action validates an action against live database state and returns a hold (approved), a rejection with optional alternatives, or the receipt of a replay.",
  "commit_action executes a held action exactly once; replays return the same receipt.",
  "get_action inspects an action by idempotency key and never executes anything.",
].join(" ");

const proposeInput = z.object({
  actionType: z.string().min(1).describe("Registered action type, for example createBooking"),
  payload: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Action payload, validated against live state at propose time"),
  idempotencyKey: z
    .string()
    .min(1)
    .max(255)
    .describe("Unique key for this logical action; replays are always safe"),
});

const commitInput = z.object({
  actionId: z.string().min(1).describe("Action id returned by propose_action"),
});

const getInput = z.object({
  idempotencyKey: z
    .string()
    .min(1)
    .max(255)
    .describe("Idempotency key used when the action was proposed"),
});

type ToolTextResult = { content: [{ type: "text"; text: string }] };
type ToolErrorResult = ToolTextResult & { isError: true };

function jsonResult(value: unknown): ToolTextResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function authorityErrorResult(error: AuthorityError): ToolErrorResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { code: error.code, message: error.message } }),
      },
    ],
    isError: true,
  };
}

/**
 * Create an MCP server exposing the authority protocol as three tools:
 * `propose_action`, `commit_action` and `get_action`.
 *
 * ```ts
 * const server = createMcpServer({ authority });
 * await connectStdio(server);
 * ```
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer(
    {
      name: options.name ?? DEFAULT_NAME,
      version: options.version ?? DEFAULT_VERSION,
    },
    { instructions: options.instructions ?? DEFAULT_INSTRUCTIONS },
  );

  server.registerTool(
    "propose_action",
    {
      title: "Propose action",
      description:
        "Validate an action against live database state. Returns a hold (approved), a rejection with optional alternatives, or the receipt of a replay. Does not execute the action.",
      inputSchema: proposeInput,
      annotations: { idempotentHint: true },
    },
    async ({ actionType, payload, idempotencyKey }) => {
      try {
        const proposal = await options.authority.propose(actionType, payload ?? {}, {
          idempotencyKey,
        });
        return jsonResult(proposal);
      } catch (error) {
        if (error instanceof AuthorityError) {
          return authorityErrorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "commit_action",
    {
      title: "Commit action",
      description:
        "Execute a held action exactly once. Replays return the same receipt and never run the effect twice.",
      inputSchema: commitInput,
      annotations: { idempotentHint: true },
    },
    async ({ actionId }) => {
      try {
        const result = await options.authority.commit(actionId);
        return jsonResult(result);
      } catch (error) {
        if (error instanceof AuthorityError) {
          return authorityErrorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "get_action",
    {
      title: "Get action",
      description:
        "Inspect an action by idempotency key: status, hold expiry, rejection reason and receipt. Never executes anything.",
      inputSchema: getInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ idempotencyKey }) => {
      const record = await options.authority.get(idempotencyKey);
      return jsonResult(record);
    },
  );

  return server;
}

/**
 * Connect a server created by {@link createMcpServer} to stdio, the transport
 * MCP clients use to spawn a server as a child process.
 */
export async function connectStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}
