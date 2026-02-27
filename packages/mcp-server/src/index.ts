import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { queryWorld } from "./query-world.js";
import { listWorlds } from "./list-worlds.js";

function createServer(): McpServer {
  const server = new McpServer({
    name: "eternum-explorer",
    version: "0.2.1",
  });

  server.registerTool(
    "list-worlds",
    {
      title: "List Active Eternum Worlds",
      description:
        "List active Eternum game worlds across chains (slot, sepolia, mainnet). " +
        "Returns worlds that are upcoming or ongoing. Each result includes: name, chain, status, toriiUrl, and worldAddress.\n\n" +
        "Use this to find a world's torii_url, then pass it to query-world.\n\n" +
        "Example:\n" +
        '  list-worlds → [{ name: "eternum-season-1", chain: "slot", status: "ongoing", toriiUrl: "https://api.cartridge.gg/x/eternum-season-1/torii" }]\n' +
        '  query-world({ question: "Who has the largest army?", torii_url: "https://api.cartridge.gg/x/eternum-season-1/torii" })',
      inputSchema: z.object({
        chain: z
          .enum(["slot", "sepolia", "mainnet"])
          .optional()
          .describe("Filter to a single chain. If omitted, discovers across all chains."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ chain }) => {
      try {
        const worlds = await listWorlds({ chain });
        if (worlds.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No active worlds found." + (chain ? ` (filtered to ${chain})` : "") }],
          };
        }
        const lines = worlds.map(
          (w) => `- ${w.name} [${w.chain}] (${w.status})\n  torii_url: ${w.toriiUrl}` + (w.worldAddress ? `\n  world_address: ${w.worldAddress}` : ""),
        );
        const text = `Found ${worlds.length} active world${worlds.length === 1 ? "" : "s"}:\n\n${lines.join("\n\n")}`;
        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing worlds: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "query-world",
    {
      title: "Query an Eternum World",
      description:
        "Ask a natural-language question about on-chain game data in an Eternum world. " +
        "Pass a torii_url to target a specific world, or omit it to auto-discover active worlds.\n\n" +
        "The agent queries Torii databases (SQLite) and returns a detailed natural-language answer. " +
        "It understands Eternum's data model: structures, troops, resources, guilds, hyperstructures, battles, and more.\n\n" +
        "Examples:\n" +
        '  query-world({ question: "Who has the largest army?", torii_url: "https://api.cartridge.gg/x/eternum-season-1/torii" })\n' +
        '  query-world({ question: "What are the top 10 guilds by member count?", torii_url: "..." })\n' +
        '  query-world({ question: "How many realms exist?" })  // auto-discovers worlds',
      inputSchema: z.object({
        question: z.string().describe("Natural language question about the world's data (e.g. players, troops, resources, guilds, structures, battles)"),
        torii_url: z.string().url().optional().describe("Torii URL for the world. Get this from list-worlds. If omitted, auto-discovers active worlds."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ question, torii_url }: { question: string; torii_url?: string }) => {
      try {
        const answer = await queryWorld(question, torii_url);
        return {
          content: [{ type: "text" as const, text: answer }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Provide actionable guidance when the Torii URL fails
        const isConnectionError = message.includes("failed") || message.includes("ECONNREFUSED") || message.includes("fetch");
        const hint = isConnectionError
          ? " This Torii URL may be unreachable or invalid — call list-worlds to find active URLs."
          : "";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}${hint}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

async function runStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Data Explorer MCP server running via stdio");
}

async function runHttp() {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    // Stateless mode: fresh server per request since McpServer
    // can only be connected to one transport at a time
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // MCP spec: GET and DELETE on /mcp should return 405
  app.get("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").json({ error: "Method Not Allowed. Use POST for MCP requests." });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").json({ error: "Method Not Allowed. Use POST for MCP requests." });
  });

  // Catch-all: return JSON for unmatched routes so MCP client OAuth
  // probes (e.g. POST /register) get a parseable response instead of HTML
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  const port = parseInt(process.env.PORT || "3001");
  app.listen(port, () => {
    console.error(`Data Explorer MCP server running on http://localhost:${port}/mcp`);
  });
}

const mode = process.env.TRANSPORT || "stdio";
if (mode === "http") {
  runHttp().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
} else {
  runStdio().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
