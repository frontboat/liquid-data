import { ToolLoopAgent, stepCountIs } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { tool } from "ai";
import { z } from "zod";
import { explorerCatalog } from "./render/catalog";
import { executeQuery, getTableSchema as getTableSchemaApi } from "./duckdb";
import { executeToriiQuery, getToriiTableSchema as getToriiTableSchemaApi, getToriiState } from "./torii";
import { decodeRows } from "./decode-hex";
import { listWorlds as listWorldsApi } from "./list-worlds";

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

  const getSchema = tool({
    description:
      "Get the schema of the uploaded data table, including column names, types, row count, and sample rows.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        return await getTableSchemaApi("data");
      } catch (error) {
        return { error: String(error) };
      }
    },
  });

  return new ToolLoopAgent({
    model: gateway(process.env.AI_GATEWAY_MODEL || DEFAULT_MODEL),
    instructions: AGENT_INSTRUCTIONS,
    tools: { queryData, getSchema },
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

  const TORII_INSTRUCTIONS = `You are a data analyst assistant connected to a Torii database — an on-chain game data indexer for Eternum, an on-chain strategy game.

AVAILABLE TABLES (${tables.length} total):
${tableListingLines.join("\n")}

ETERNUM DATA MODEL:
Tables use the "s1_eternum-" prefix. Always double-quote table names: SELECT * FROM "s1_eternum-Structure"

Entity relationships:
  Player (address) → owns Structures (via owner field)
  Structure (entity_id) → owns Explorers (via ExplorerTroops.owner = structure.entity_id)
  Player → Guild (via GuildMember.member = player_address, GuildMember.guild_id = Guild.guild_id)

Structure categories (category column):
  1 = Realm, 2 = Hyperstructure, 3 = Bank, 4 = Mine, 5 = Village

Key tables and what they store:
  "s1_eternum-Structure" — all buildings (coords, owner, category, level, metadata)
  "s1_eternum-Resource" — resource balances per entity (join on entity_id)
  "s1_eternum-ExplorerTroops" — armies/explorers (coords, troops, owner=structure entity_id)
  "s1_eternum-AddressName" — player display names
  "s1_eternum-Guild" / "s1_eternum-GuildMember" — guild info
  "s1_eternum-Hyperstructure" / "s1_eternum-HyperstructureShareholders" — hyperstructure ownership
  "s1_eternum-BattleEvent" / "s1_eternum-ExplorerNewRaidEvent" — combat logs
  "s1_eternum-PlayerRegisteredPoints" — leaderboard points (hex-encoded)
  "s1_eternum-Building" / "s1_eternum-StructureBuildings" — buildings within structures
  "s1_eternum-StoryEvent" — game event log (filtered by "story" column for event type)
  "s1_eternum-TileOpt" — map tiles
  "s1_eternum-WorldConfig" — season config (start/end timestamps)
  "s1_eternum-RelicEffect" — relic modifiers on entities
  "s1_eternum-StructureOwnerStats" — aggregated player stats

Column conventions:
  Coordinates: "base.coord_x", "base.coord_y" (structures) or "coord.x", "coord.y" (explorers)
  Nested structs use dot notation: "troop_guards.delta.count", "troops.stamina.amount"
  Guard slots: delta, charlie, bravo, alpha (4 slots per structure)
  Troop fields: .category, .tier, .count, .stamina.amount, .stamina.updated_tick
  Resource balances: columns named like STONE_BALANCE, COAL_BALANCE, etc. (hex strings — use CAST or hex conversion)
  Resource production: STONE_PRODUCTION.building_count, .production_rate, .output_amount_left, .last_updated_at

Common joins:
  Structure + Resources: JOIN "s1_eternum-Resource" r ON s.entity_id = r.entity_id
  Structure + Owner stats: JOIN "s1_eternum-StructureOwnerStats" sos ON sos.owner = s.owner
  Explorer + Owner structure: JOIN "s1_eternum-Structure" s ON s.entity_id = et.owner
  Guild lookup: JOIN "s1_eternum-GuildMember" gm ON gm.member = s.owner JOIN "s1_eternum-Guild" g ON g.guild_id = gm.guild_id

Addresses: stored as 0x-prefixed 64-char padded hex strings (left as-is in query results).
Hex decoding is automatic: the queryData tool converts 0x hex values to numbers for you.
  Resource balances (*_BALANCE) and troop counts (*_count, .count) are divided by RESOURCE_PRECISION (1,000,000,000) so you see actual amounts (e.g. 5 stone, not 5000000000).
  Address/entity/owner columns stay as hex strings.
IMPORTANT — filtering/sorting on hex columns: balance and count columns are stored as hex strings in the DB.
  To filter or sort by actual amounts, decode in a subquery first:
  SELECT * FROM (
    SELECT *, CAST(STONE_BALANCE AS INTEGER) / 1000000000 AS stone FROM "s1_eternum-Resource"
  ) WHERE stone > 42 ORDER BY stone DESC
  Always use this pattern when comparing or ordering by resource/troop amounts.
Timestamps: mix of game ticks (numeric) and unix seconds — check column names for context.

WORKFLOW:
1. Use the listTables tool to browse available tables (with optional name filter)
2. Use the getSchema tool to inspect a specific table's columns, types, row count, and sample rows
3. Use the queryData tool to run SQL queries against the database
4. Respond with a brief conversational summary of what you found
5. Then output a \`\`\`spec fence with a JSONL UI spec to render a rich visual dashboard

DISCOVERING OTHER WORLDS:
- If the user asks about other worlds, active games, or available Eternum instances, use the listWorlds tool.
- It returns a list of active worlds with: name, chain, status (upcoming/ongoing), toriiUrl, and worldAddress.
- Present the results to the user so they can choose which world to explore.

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

  const getSchema = tool({
    description:
      "Get the full schema of a specific table: column names, types, row count, and 5 sample rows. Use this before querying an unfamiliar table.",
    inputSchema: z.object({
      tableName: z.string().describe("The exact table name to inspect"),
    }),
    execute: async ({ tableName }) => {
      try {
        return await getToriiTableSchemaApi(tableName);
      } catch (error) {
        return { error: String(error) };
      }
    },
  });

  const queryData = tool({
    description:
      "Execute a SQL query against the Torii database (SQLite dialect). Double-quote table names with hyphens. Returns up to 1000 rows. " +
      "Hex values are auto-decoded: resource balances and troop counts are divided by RESOURCE_PRECISION (1e9) to give actual amounts. " +
      "Address/entity columns are left as hex strings.",
    inputSchema: z.object({
      sql: z.string().describe("SQL query (SQLite dialect). Double-quote table names with hyphens."),
    }),
    execute: async ({ sql }) => {
      try {
        const limited = `SELECT * FROM (${sql.replace(/;\s*$/, "")}) LIMIT 1001`;
        const results = await executeToriiQuery(limited);
        const decoded = decodeRows(results.slice(0, 1000));
        return {
          rows: decoded,
          totalRows: results.length,
          truncated: results.length > 1000,
        };
      } catch (error) {
        return { error: String(error), rows: [], totalRows: 0 };
      }
    },
  });

  const listWorlds = tool({
    description:
      "List active Eternum game worlds across chains (slot, sepolia, mainnet). " +
      "Returns worlds that are upcoming or ongoing, with their name, chain, status, and toriiUrl. " +
      "Use when the user asks about other worlds, active games, or available Eternum instances. " +
      "Present the results so the user can choose which world to explore.",
    inputSchema: z.object({
      chain: z
        .enum(["slot", "sepolia", "mainnet"])
        .optional()
        .describe("Filter to a single chain. If omitted, discovers across all chains."),
    }),
    execute: async ({ chain }) => {
      try {
        const worlds = await listWorldsApi({ chain });
        if (worlds.length === 0) {
          return { summary: "No active worlds found." + (chain ? ` (filtered to ${chain})` : "") };
        }
        const lines = worlds.map(
          (w) => `- ${w.name} [${w.chain}] (${w.status})\n  toriiUrl: ${w.toriiUrl}` + (w.worldAddress ? `\n  worldAddress: ${w.worldAddress}` : ""),
        );
        return { summary: `Found ${worlds.length} active world${worlds.length === 1 ? "" : "s"}:\n\n${lines.join("\n\n")}` };
      } catch (error) {
        return { error: String(error) };
      }
    },
  });

  return new ToolLoopAgent({
    model: gateway(process.env.AI_GATEWAY_MODEL || DEFAULT_MODEL),
    instructions: TORII_INSTRUCTIONS,
    tools: { queryData, getSchema, listTables, listWorlds },
    stopWhen: stepCountIs(12),
    temperature: 0.7,
  });
}
