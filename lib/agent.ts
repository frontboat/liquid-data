import { ToolLoopAgent, stepCountIs } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { tool } from "ai";
import { z } from "zod";
import { explorerCatalog } from "./render/catalog";
import { executeQuery, getTableSchema as getTableSchemaApi } from "./duckdb";
import { executeToriiQuery, getToriiTableSchema as getToriiTableSchemaApi, getToriiState } from "./torii";
import { decodeRows, decodePaddedFeltAscii } from "./decode-hex";
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
    providerOptions: { gateway: { caching: "auto" } },
  });
}

// NOTE: UI Torii agent uses 0.7 temperature because it renders UI specs
// where some creative variance is acceptable, unlike the MCP agent (0.1)
// which must return deterministic data answers.
export function createToriiAgent() {
  const state = getToriiState();
  if (!state) throw new Error("Torii not connected");

  const tables = state.tables;
  const isEternum = tables.some((t) => t.name.startsWith("s1_eternum-"));

  const ETERNUM_DATA_MODEL = `
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
  "s1_eternum-AddressName" — player display names (felt-encoded, auto-decoded)
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
  Resource balances: columns named like STONE_BALANCE, COAL_BALANCE, etc. (hex strings, auto-decoded by queryData)
  Resource production: STONE_PRODUCTION.building_count, .production_rate, .output_amount_left, .last_updated_at

Common joins:
  Structure + Resources: JOIN "s1_eternum-Resource" r ON s.entity_id = r.entity_id
  Structure + Owner stats: JOIN "s1_eternum-StructureOwnerStats" sos ON sos.owner = s.owner
  Explorer + Owner structure: JOIN "s1_eternum-Structure" s ON s.entity_id = et.owner
  Guild lookup: JOIN "s1_eternum-GuildMember" gm ON gm.member = s.owner JOIN "s1_eternum-Guild" g ON g.guild_id = gm.guild_id

Addresses: stored as 0x-prefixed 64-char padded hex strings (left as-is in query results).
Hex decoding is automatic: the queryData tool converts 0x hex values to numbers for you.
  Resource balances (*_BALANCE) and troop counts (*_count, .count) are divided by RESOURCE_PRECISION (1,000,000,000) so you see actual amounts (e.g. 5 stone, not 5000000000).
  Felt-encoded strings (name, guild_name, message, story columns) are auto-decoded to readable text.
  Address/entity/owner columns stay as hex strings.
IMPORTANT — SELECT raw column values exactly as stored. Do NOT use CAST() or manual hex conversion in your SELECT columns.
  The queryData tool handles all decoding automatically. If you CAST or convert values in SQL, the auto-decoding cannot process them correctly.
  Hex columns sort lexicographically, not numerically. Always use CAST in ORDER BY:
    SELECT "troops.count", "troops.category" FROM "s1_eternum-ExplorerTroops" ORDER BY CAST("troops.count" AS INTEGER) DESC LIMIT 5
  For filtering, use CAST in WHERE:
    SELECT * FROM "s1_eternum-ExplorerTroops" WHERE CAST("troops.count" AS INTEGER) > 0
Timestamps: mix of game ticks (numeric) and unix seconds — check column names for context.`;

  const ETERNUM_RULES = `- Use getPlayers for player counts, leaderboards, structure counts, points, or guild membership.
- Use getTroops for armies, troop counts, military rankings, or explorer positions. Pass playerName to filter to one player.
- Use getNearbyTroops for proximity/threat questions. Specify the reference via playerName, coords (raw DB values), or entityId.
  - playerName + relativeTo='troops' measures from a player's armies instead of structures.
  - Coordinates must be raw DB values (e.g. 1225670892, not relative like 892).
- Fall back to queryData for everything else (resources, battles, events, buildings, etc.).`;

  const intro = isEternum
    ? `You are a data analyst assistant connected to a Torii database — an on-chain game data indexer for Eternum, an on-chain strategy game.`
    : `You are a data analyst assistant connected to a Torii database — an on-chain game data indexer that stores smart contract state as SQLite tables.`;

  const TORII_INSTRUCTIONS = `${intro}
${isEternum ? ETERNUM_DATA_MODEL : ""}
WORKFLOW:
1. Use the listTables tool to browse available tables (with optional name filter)
2. Use the getSchema tool to inspect a specific table's columns, types, row count, and sample rows
3. Use the queryData tool to run SQL queries against the database
4. Respond with a brief conversational summary of what you found
5. Then output a \`\`\`spec fence with a JSONL UI spec to render a rich visual dashboard

${isEternum ? `DISCOVERING OTHER WORLDS:
- If the user asks about other worlds, active games, or available Eternum instances, use the listWorlds tool.
- It returns a list of active worlds with: name, chain, status (upcoming/ongoing), toriiUrl, and worldAddress.
- Present the results to the user so they can choose which world to explore.
` : ""}RULES:
- ALWAYS query the data first. NEVER make up numbers or guess values.
${isEternum ? ETERNUM_RULES : "- Start with listTables to discover what data is available, then use getSchema to understand table structure."}
- This is SQLite dialect. NOT DuckDB or Postgres.
- Table names containing hyphens or special chars MUST be double-quoted: SELECT * FROM "my-table"
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
- Hex values (0x-prefixed) are auto-decoded to numbers by the queryData tool.

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
        const decoded = decodeRows(results.slice(0, 1000), { stripZeros: true });
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

  const getPlayers = tool({
    description:
      "Get all players with their structure counts, registered points, and guild membership. " +
      "Returns one row per player with: player_name, address, structure_count, registered_points, guild_name. " +
      "Use this for any question about player counts, leaderboards, structure counts, points, or guild membership.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const sql = `
          SELECT an.name as player_name, an.address,
                 COALESCE(sc.structure_count, 0) as structure_count,
                 pp.registered_points,
                 g.name as guild_name
          FROM "s1_eternum-AddressName" an
          LEFT JOIN (
            SELECT owner, COUNT(*) as structure_count
            FROM "s1_eternum-Structure" GROUP BY owner
          ) sc ON sc.owner = an.address
          LEFT JOIN "s1_eternum-PlayerRegisteredPoints" pp ON pp.address = an.address
          LEFT JOIN "s1_eternum-GuildMember" gm ON gm.member = an.address
          LEFT JOIN "s1_eternum-Guild" g ON g.guild_id = gm.guild_id
        `;
        const results = await executeToriiQuery(sql);
        const decoded = decodeRows(results, { stripZeros: false });
        return { players: decoded, totalPlayers: decoded.length };
      } catch (error) {
        return { error: String(error) };
      }
    },
  });

  const getTroops = tool({
    description:
      "Get explorer armies with their owner player names, troop types, counts, and positions. " +
      "Optionally filter to a single player by name. " +
      "Returns one row per explorer with: player_name, address, explorer_id, troops.category, troops.tier, troops.count, coord.x, coord.y. " +
      "Troop counts are auto-decoded (divided by RESOURCE_PRECISION). " +
      "Use this for any question about armies, troop counts, military rankings, or explorer positions.",
    inputSchema: z.object({
      playerName: z.string().optional().describe("Optional player name to filter by (e.g. 'boat'). If omitted, returns all armies."),
    }),
    execute: async ({ playerName }) => {
      try {
        let addressFilter = "";
        if (playerName) {
          const target = playerName.toLowerCase();
          const names = await executeToriiQuery(`SELECT name, address FROM "s1_eternum-AddressName"`);
          const match = names.find((r) => decodePaddedFeltAscii(String(r.name)).toLowerCase() === target);
          if (!match) {
            const allNames = names.map((r) => decodePaddedFeltAscii(String(r.name))).filter(Boolean);
            return { error: `Player "${playerName}" not found. Available players: ${allNames.join(", ")}` };
          }
          addressFilter = ` WHERE s.owner = '${match.address}'`;
        }

        const sql = `
          SELECT an.name as player_name, an.address,
                 et.explorer_id, et."troops.category", et."troops.tier", et."troops.count",
                 et."coord.x", et."coord.y"
          FROM "s1_eternum-ExplorerTroops" et
          JOIN "s1_eternum-Structure" s ON s.entity_id = et.owner
          JOIN "s1_eternum-AddressName" an ON an.address = s.owner
          ${addressFilter}
        `;
        const results = await executeToriiQuery(sql);
        const decoded = decodeRows(results, { stripZeros: false });
        return { troops: decoded, totalExplorers: decoded.length };
      } catch (error) {
        return { error: String(error) };
      }
    },
  });

  const getNearbyTroops = tool({
    description:
      "Get all armies sorted by distance from a reference point. The reference can be specified in three ways:\n" +
      "1. playerName — distance from that player's structures (or armies if relativeTo='troops')\n" +
      "2. coords — distance from an exact {x, y} coordinate\n" +
      "3. entityId — distance from a specific structure or explorer by entity ID\n" +
      "Provide exactly one of these. " +
      "Each row includes: player_name, address, explorer_id, troops.category, troops.tier, troops.count, coord.x, coord.y, distance, nearest_ref. " +
      "Use this for proximity/threat questions like 'what armies are near X'.",
    inputSchema: z.object({
      playerName: z.string().optional().describe("Player name to center on (e.g. 'boat')"),
      relativeTo: z.enum(["structures", "troops"]).optional().describe("When using playerName: measure from structures (default) or armies"),
      coords: z.object({ x: z.number(), y: z.number() }).optional().describe("Exact coordinates in raw DB format (e.g. 1225670892, not relative). Get these from structure/explorer query results."),
      entityId: z.number().optional().describe("Entity ID of a structure or explorer to measure distance from"),
    }),
    execute: async ({ playerName, relativeTo, coords, entityId }) => {
      try {
        let refPoints: Array<{ x: number; y: number; id: number | string }>;

        if (coords) {
          refPoints = [{ x: coords.x, y: coords.y, id: "coord" }];
        } else if (entityId != null) {
          const structRows = await executeToriiQuery(
            `SELECT entity_id, "base.coord_x", "base.coord_y" FROM "s1_eternum-Structure" WHERE entity_id = ${entityId}`,
          );
          if (structRows.length > 0) {
            const sr = structRows[0] as Record<string, unknown>;
            refPoints = [{ x: Number(sr["base.coord_x"]), y: Number(sr["base.coord_y"]), id: entityId }];
          } else {
            const explorerRows = await executeToriiQuery(
              `SELECT explorer_id, "coord.x", "coord.y" FROM "s1_eternum-ExplorerTroops" WHERE explorer_id = ${entityId}`,
            );
            if (explorerRows.length > 0) {
              const er = explorerRows[0] as Record<string, unknown>;
              refPoints = [{ x: Number(er["coord.x"]), y: Number(er["coord.y"]), id: entityId }];
            } else {
              return { error: `Entity ${entityId} not found in structures or explorers.` };
            }
          }
        } else if (playerName) {
          const target = playerName.toLowerCase();
          const mode = relativeTo ?? "structures";

          const names = await executeToriiQuery(`SELECT name, address FROM "s1_eternum-AddressName"`);
          const match = names.find((r) => decodePaddedFeltAscii(String(r.name)).toLowerCase() === target);
          if (!match) {
            const allNames = names.map((r) => decodePaddedFeltAscii(String(r.name))).filter(Boolean);
            return { error: `Player "${playerName}" not found. Available players: ${allNames.join(", ")}` };
          }
          const address = match.address as string;

          if (mode === "troops") {
            const playerTroops = await executeToriiQuery(
              `SELECT et.explorer_id, et."coord.x", et."coord.y"
               FROM "s1_eternum-ExplorerTroops" et
               JOIN "s1_eternum-Structure" s ON s.entity_id = et.owner
               WHERE s.owner = '${address}'`,
            );
            if (playerTroops.length === 0) {
              return { error: `Player "${playerName}" has no armies.` };
            }
            refPoints = playerTroops.map((t) => ({
              x: Number(t["coord.x"]),
              y: Number(t["coord.y"]),
              id: Number(t["explorer_id"]),
            }));
          } else {
            const structs = await executeToriiQuery(
              `SELECT entity_id, "base.coord_x", "base.coord_y" FROM "s1_eternum-Structure" WHERE owner = '${address}'`,
            );
            if (structs.length === 0) {
              return { error: `Player "${playerName}" has no structures.` };
            }
            refPoints = structs.map((s) => ({
              x: Number(s["base.coord_x"]),
              y: Number(s["base.coord_y"]),
              id: Number(s["entity_id"]),
            }));
          }
        } else {
          return { error: "Provide one of: playerName, coords, or entityId." };
        }

        const sql = `
          SELECT an.name as player_name, an.address,
                 et.explorer_id, et."troops.category", et."troops.tier", et."troops.count",
                 et."coord.x", et."coord.y"
          FROM "s1_eternum-ExplorerTroops" et
          JOIN "s1_eternum-Structure" s ON s.entity_id = et.owner
          JOIN "s1_eternum-AddressName" an ON an.address = s.owner
        `;
        const results = await executeToriiQuery(sql);
        const decoded = decodeRows(results, { stripZeros: false });

        const withDistance = decoded.map((row) => {
          const ex = Number(row["coord.x"]);
          const ey = Number(row["coord.y"]);
          let minDist = Infinity;
          let nearestRef: number | string | undefined;
          for (const ref of refPoints) {
            const d = Math.sqrt((ex - ref.x) ** 2 + (ey - ref.y) ** 2);
            if (d < minDist) {
              minDist = d;
              nearestRef = ref.id;
            }
          }
          return {
            ...row,
            distance: Math.round(minDist * 10) / 10,
            nearest_ref: nearestRef,
          };
        });
        withDistance.sort((a, b) => a.distance - b.distance);

        return {
          referencePoints: refPoints,
          troops: withDistance,
          totalExplorers: withDistance.length,
        };
      } catch (error) {
        return { error: String(error) };
      }
    },
  });

  const baseTools = { queryData, getSchema, listTables };
  const tools = isEternum
    ? { ...baseTools, listWorlds, getPlayers, getTroops, getNearbyTroops }
    : baseTools;

  return new ToolLoopAgent({
    model: gateway(process.env.AI_GATEWAY_MODEL || DEFAULT_MODEL),
    instructions: TORII_INSTRUCTIONS,
    tools,
    stopWhen: stepCountIs(12),
    temperature: 0.7,
    providerOptions: { gateway: { caching: "auto" } },
  });
}
