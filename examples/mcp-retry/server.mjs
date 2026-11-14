import { connectStdio, createMcpServer } from "exactly-once/mcp";
import { createExampleAuthority } from "./authority.mjs";

const { authority, pool } = await createExampleAuthority();
const server = createMcpServer({ authority });

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await server.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await connectStdio(server);
