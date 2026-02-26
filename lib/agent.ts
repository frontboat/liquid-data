import { ToolLoopAgent, stepCountIs } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { tool } from "ai";
import { z } from "zod";
import { explorerCatalog } from "./render/catalog";
import { executeQuery, getTableSchema } from "./duckdb";
import { executeToriiQuery, getToriiTableSchema, getToriiState } from "./torii";

const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

export function createAgent(schemaInfo: { columns: Array<{ name: string; type: string }>; rowCount: number }) {
  const schemaDescription = schemaInfo.columns
    .map((c) => `  - ${c.name} (${c.type})`)
    .join("\n");

  const AGENT_INSTRUCTIONS = `You are a data analyst assistant. The user has uploaded a CSV dataset that is loaded into a DuckDB table called "data".

TABLE SCHEMA:
${schemaDescription}

Total rows: ${schemaInfo.rowCount}

WORKFLOW:
1. First use the getSchema tool if you need to understand the data better (sample values, etc.)
2. Use the queryData tool to run SQL queries against the "data" table to answer the user's question
3. Respond with a brief conversational summary of what you found
4. Then output a \`\`\`spec fence with a JSONL UI spec to render a rich visual dashboard

RULES:
- ALWAYS query the data first. NEVER make up numbers or guess values.
- The table is called "data". Use standard SQL (DuckDB dialect).
- Embed fetched data directly in /state paths so components can reference it with { "$state": "/path" }.
- Use Card components to group related information.
- NEVER nest a Card inside another Card.
- Use Grid with columns='2' or columns='3' for side-by-side layouts.
- Use Metric for key numeric values (totals, averages, counts, etc.).
- Use Table for detailed row-level data.
- Use BarChart for comparisons and categorical data.
- Use LineChart for time series and trends.
- Use PieChart for proportions and distributions.
- Use Tabs when showing multiple views of the data.
- Use Callout for key insights or surprising findings.
- Keep the UI clean and information-dense.
- Put chart/table data arrays in /state and reference them with { "$state": "/path" } on the data prop.
- Always emit /state patches BEFORE the elements that reference them.
- For numeric formatting, round to 2 decimal places where appropriate.

${explorerCatalog.prompt({
  mode: "chat",
  customRules: [
    "NEVER use viewport height classes (min-h-screen, h-screen) — the UI renders inside a fixed-size container.",
    "Prefer Grid with columns='2' or columns='3' for side-by-side layouts.",
    "Use Metric components for key numbers instead of plain Text.",
    "Put chart data arrays in /state and reference them with { $state: '/path' } on the data prop.",
    "Keep the UI clean and information-dense — no excessive padding or empty space.",
  ],
})}`;

  const queryData = tool({
    description:
      "Execute a SQL query against the uploaded CSV data. The data is in a table called 'data'. Returns up to 1000 rows. Use standard SQL (DuckDB dialect).",
    inputSchema: z.object({
      sql: z.string().describe("SQL query to execute against the 'data' table"),
    }),
    execute: async ({ sql }) => {
      try {
        // Wrap in a subquery with LIMIT to prevent unbounded result sets
        const limited = `SELECT * FROM (${sql.replace(/;\s*$/, "")}) LIMIT 1001`;
        const results = await executeQuery(limited);
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

  const getSchemaTool = tool({
    description:
      "Get the schema of the uploaded data table, including column names, types, row count, and sample rows.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        return await getTableSchema("data");
      } catch (error) {
        return { error: String(error) };
      }
    },
  });

  return new ToolLoopAgent({
    model: gateway(process.env.AI_GATEWAY_MODEL || DEFAULT_MODEL),
    instructions: AGENT_INSTRUCTIONS,
    tools: { queryData, getSchema: getSchemaTool },
    stopWhen: stepCountIs(8),
    temperature: 0.7,
  });
}

export function createToriiAgent() {
  const state = getToriiState();
  if (!state) throw new Error("Torii not connected");

  const tables = state.tables;

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

  const TORII_INSTRUCTIONS = `You are a data analyst assistant connected to a Torii database — an on-chain game data indexer.

AVAILABLE TABLES (${tables.length} total):
${tableListingLines.join("\n")}

WORKFLOW:
1. Use the listTables tool to browse available tables (with optional name filter)
2. Use the getSchema tool to inspect a specific table's columns, types, row count, and sample rows
3. Use the queryData tool to run SQL queries against the database
4. Respond with a brief conversational summary of what you found
5. Then output a \`\`\`spec fence with a JSONL UI spec to render a rich visual dashboard

RULES:
- ALWAYS query the data first. NEVER make up numbers or guess values.
- This is SQLite dialect. NOT DuckDB or Postgres.
- Table names containing hyphens MUST be double-quoted: SELECT * FROM "s1_eternum-Structure"
- Use the getSchema tool before querying an unfamiliar table to understand its columns.
- Keep queries efficient — use LIMIT, avoid SELECT * on wide tables (some have 200+ columns).
- Only select the columns you actually need.
- Embed fetched data directly in /state paths so components can reference it with { "$state": "/path" }.
- Use Card components to group related information. NEVER nest Cards.
- Use Grid with columns='2' or columns='3' for side-by-side layouts.
- Use Metric for key numeric values (totals, averages, counts, etc.).
- Use Table for detailed row-level data.
- Use BarChart for comparisons and categorical data.
- Use LineChart for time series and trends.
- Use PieChart for proportions and distributions.
- Use Tabs when showing multiple views of the data.
- Use Callout for key insights or surprising findings.
- Keep the UI clean and information-dense.
- Put chart/table data arrays in /state and reference them with { "$state": "/path" } on the data prop.
- Always emit /state patches BEFORE the elements that reference them.
- For numeric formatting, round to 2 decimal places where appropriate.

${explorerCatalog.prompt({
    mode: "chat",
    customRules: [
      "NEVER use viewport height classes (min-h-screen, h-screen) — the UI renders inside a fixed-size container.",
      "Prefer Grid with columns='2' or columns='3' for side-by-side layouts.",
      "Use Metric components for key numbers instead of plain Text.",
      "Put chart data arrays in /state and reference them with { $state: '/path' } on the data prop.",
      "Keep the UI clean and information-dense — no excessive padding or empty space.",
    ],
  })}`;

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
        return await getToriiTableSchema(tableName);
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
        const results = await executeToriiQuery(limited);
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
    model: gateway(process.env.AI_GATEWAY_MODEL || DEFAULT_MODEL),
    instructions: TORII_INSTRUCTIONS,
    tools: { queryData, getSchema: getSchemaTool, listTables },
    stopWhen: stepCountIs(12),
    temperature: 0.7,
  });
}
