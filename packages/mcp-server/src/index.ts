import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { handleQuery } from "./query.js";

const server = new McpServer({
  name: "data-explorer",
  version: "0.1.0",
});

server.registerTool(
  "query",
  {
    title: "Query Torii Database",
    description:
      "Ask a natural-language question about data in a Torii database. " +
      "Connects to the given Torii URL, inspects the schema, generates and runs SQL queries, " +
      "and returns a natural-language answer with the relevant data.",
    inputSchema: z.object({
      question: z.string().describe("Natural language question about the data"),
      torii_url: z.string().url().describe("Base URL of the Torii instance"),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ question, torii_url }) => {
    try {
      const answer = await handleQuery(question, torii_url);
      return {
        content: [{ type: "text" as const, text: answer }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

async function runStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Data Explorer MCP server running via stdio");
}

async function runHttp() {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
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
