import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/mcp.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: "node",
  deps: { neverBundle: ["@modelcontextprotocol/sdk", "zod"] },
});
