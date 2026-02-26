import { ToolLoopAgent, stepCountIs } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { tool } from "ai";
import { z } from "zod";
import { ToriiConnection, executeToriiQuery, getToriiTableSchema } from "./torii.js";

export function createMcpAgent(conn: ToriiConnection) {
  const tables = conn.tables;

  // Group tables by namespace prefix for compact listing
  const grouped: Record<string, string[]> = {};
  for (const t of tables) {
    const dashIdx = t.name.indexOf("-");
    const ns = dashIdx > 0 ? t.name.substring(0, dashIdx) : "core";
    (grouped[ns] ??= []).push(t.name);
  }

  const tableListingLines: string[] = [];
  for (const [ns, names] of Object.entries(grouped).sort()) {
    const entries = names.map((n) => {
      const t = tables.find((x) => x.name === n)!;
      return `${n} (${t.columns.length} cols)`;
    });
    tableListingLines.push(`[${ns}] ${names.length} tables: ${entries.join(", ")}`);
  }

  const instructions = `You are a data analyst assistant connected to a Torii database — an on-chain game data indexer.

AVAILABLE TABLES (${tables.length} total):
${tableListingLines.join("\n")}

WORKFLOW:
1. Use the listTables tool to browse available tables (with optional name filter)
2. Use the getSchema tool to inspect a specific table's columns, types, row count, and sample rows
3. Use the queryData tool to run SQL queries against the database
4. Respond with a clear, thorough natural-language answer to the user's question

Include in your response:
- The specific numbers, values, or data points that answer the question
- Brief context on what tables/queries you used
- If the data reveals something notable or surprising, mention it

RULES:
- ALWAYS query the data first. NEVER make up numbers or guess values.
- This is SQLite dialect. NOT DuckDB or Postgres.
- Table names containing hyphens MUST be double-quoted: SELECT * FROM "s1_eternum-Structure"
- Use the getSchema tool before querying an unfamiliar table to understand its columns.
- Keep queries efficient — use LIMIT, avoid SELECT * on wide tables (some have 200+ columns).
- Only select the columns you actually need.
- For numeric formatting, round to 2 decimal places where appropriate.
- Do NOT output any UI markup, JSON specs, or rendering instructions. Plain text only.`;

  const listTables = tool({
    description:
      "List available tables, optionally filtered by name substring. Returns table names and column counts.",
    inputSchema: z.object({
      filter: z.string().optional().describe("Optional substring to filter table names (case-insensitive)"),
    }),
    execute: async ({ filter }) => {
      let filtered = tables;
      if (filter) {
        const lower = filter.toLowerCase();
        filtered = tables.filter((t) => t.name.toLowerCase().includes(lower));
      }
      return filtered.map((t) => ({ name: t.name, columnCount: t.columns.length }));
    },
  });

  const getSchemaTool = tool({
    description:
      "Get the full schema of a specific table: column names, types, row count, and 5 sample rows. Use this before querying an unfamiliar table.",
    inputSchema: z.object({
      tableName: z.string().describe("The exact table name to inspect"),
    }),
    execute: async ({ tableName }) => {
      try {
        return await getToriiTableSchema(conn, tableName);
      } catch (error) {
        return { error: String(error) };
      }
    },
  });

  const queryData = tool({
    description:
      "Execute a SQL query against the Torii database (SQLite dialect). Double-quote table names with hyphens. Returns up to 1000 rows.",
    inputSchema: z.object({
      sql: z.string().describe("SQL query (SQLite dialect). Double-quote table names with hyphens."),
    }),
    execute: async ({ sql }) => {
      try {
        const limited = `SELECT * FROM (${sql.replace(/;\s*$/, "")}) LIMIT 1001`;
        const results = await executeToriiQuery(conn, limited);
        return {
          rows: results.slice(0, 1000),
          totalRows: results.length,
          truncated: results.length > 1000,
        };
      } catch (error) {
        return { error: String(error), rows: [], totalRows: 0 };
      }
    },
  });

  return new ToolLoopAgent({
    model: gateway(process.env.AI_GATEWAY_MODEL || "anthropic/claude-haiku-4.5"),
    instructions,
    tools: { queryData, getSchema: getSchemaTool, listTables },
    stopWhen: stepCountIs(12),
    temperature: 0.7,
  });
}
