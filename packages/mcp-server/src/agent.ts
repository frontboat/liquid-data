import { ToolLoopAgent, stepCountIs } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import { ToriiConnection, connectTorii, executeToriiQuery, getToriiTableSchema as getToriiTableSchemaApi } from "./torii.js";
import { decodeRows, decodePaddedFeltAscii } from "./decode-hex.js";

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  fetch: async (url, init) => {
    if (init?.body) {
      const body = JSON.parse(init.body as string);
      const prefix = JSON.stringify({ system: body.system, tools: body.tools });
      const hash = Buffer.from(prefix).toString("base64").slice(0, 40);
      const sysCc = (body.system || []).map((s: any) => s.cache_control).filter(Boolean);
      const toolCc = (body.tools || []).map((t: any) => t.cache_control).filter(Boolean);
      console.error(`[req] hash=${hash} sys_cc=${JSON.stringify(sysCc)} tool_cc=${JSON.stringify(toolCc)}`);
    }
    return fetch(url, init);
  },
});

function fullSchemaListing(tables: ToriiConnection["tables"]): string {
  return tables
    .map((t) => `${t.name}: ${t.columns.map((c) => c.name).join(", ")}`)
    .join("\n");
}

const DATA_MODEL = `ETERNUM DATA MODEL:
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

const RESPONSE_FORMAT = `Include in your response:
- The specific numbers, values, or data points that answer the question
- The data as requested by the user, and if necessary, respond with a recommendation follow-up prompt that the user could use on a session with zero context
- Brief context on what tables/queries you used
- If the data reveals something notable or surprising, mention it
- Brief insight on what tables may be related for further insight`;

const ETERNUM_RULES = `RULES:
- ALWAYS query the data first. NEVER make up numbers or guess values.
- Use getPlayers for player counts, leaderboards, structure counts, points, or guild membership.
- Use getTroops for armies, troop counts, military rankings, or explorer positions. Pass playerName to filter to one player.
- Use getNearbyTroops for proximity/threat questions. Specify the reference via playerName, coords (raw DB values), or entityId.
  - playerName + relativeTo='troops' measures from a player's armies instead of structures.
  - Coordinates must be raw DB values (e.g. 1225670892, not relative like 892).
- Fall back to queryData for everything else (resources, battles, events, buildings, etc.).
- Tables may be interconnected and user questions may require exploring, identifying, and retrieving loops.
- This is SQLite dialect. NOT DuckDB or Postgres.
- Table names containing hyphens MUST be double-quoted: SELECT * FROM "s1_eternum-Structure"
- Keep queries efficient — use LIMIT, avoid SELECT * on wide tables (some have 200+ columns).
- Only select the columns you actually need.
- For numeric formatting, round to 2 decimal places where appropriate.
- Do NOT output any UI markup, JSON specs, or rendering instructions. Plain text only.
- Every tool call requires a toriiUrl parameter. Use the URL provided in your context.`;

const GENERIC_RULES = `RULES:
- ALWAYS query the data first. NEVER make up numbers or guess values.
- Tables may be interconnected and user questions may require exploring, identifying, and retrieving loops.
- This is SQLite dialect. NOT DuckDB or Postgres.
- Table names containing hyphens or special chars MUST be double-quoted: SELECT * FROM "my-table"
- Keep queries efficient — use LIMIT, avoid SELECT * on wide tables.
- Only select the columns you actually need.
- For numeric formatting, round to 2 decimal places where appropriate.
- Do NOT output any UI markup, JSON specs, or rendering instructions. Plain text only.
- Every tool call requires a toriiUrl parameter. Use the URL provided in your context.
- Hex values (0x-prefixed) are auto-decoded to numbers by the queryData tool.`;

function hasEternumTables(tables: ToriiConnection["tables"]): boolean {
  return tables.some((t) => t.name.startsWith("s1_eternum-"));
}

export function createMcpAgent(preConnected: { url: string; tables: ToriiConnection["tables"] }) {
  const isEternum = hasEternumTables(preConnected.tables);

  const intro = isEternum
    ? `You are a data analyst assistant for Eternum, an on-chain strategy game. You query Torii databases — on-chain game data indexers.`
    : `You are a data analyst assistant for on-chain game data. You query Torii databases — on-chain game data indexers that store smart contract state as SQLite tables.`;

  const dataModel = isEternum ? `\n${DATA_MODEL}` : "";
  const rules = isEternum ? ETERNUM_RULES : GENERIC_RULES;

  const instructions = `${intro}
${dataModel}

CONNECTED TO: ${preConnected.url}

FULL SCHEMA (${preConnected.tables.length} tables):
${fullSchemaListing(preConnected.tables)}

WORKFLOW:
1. The full schema with all column names is provided above — use it to write queries directly
2. Use queryData to run SQL queries against the database
3. Respond with a clear, thorough natural-language answer to the user's question

${RESPONSE_FORMAT}

${rules}`;

  // --- Tools ---

  const getSchema = tool({
    description:
      "Get sample rows and row count for a specific table. Use when you need to see what the data looks like before writing a query.",
    inputSchema: z.object({
      toriiUrl: z.string().url().describe("Torii URL of the world to query"),
      tableName: z.string().describe("The exact table name to inspect"),
    }),
    execute: async ({ toriiUrl, tableName }) => {
      try {
        const conn = await connectTorii(toriiUrl);
        return await getToriiTableSchemaApi(conn, tableName);
      } catch (error) {
        return { error: String(error) };
      }
    },
  });

  const queryData = tool({
    description:
      "Execute a SQL query against a Torii database (SQLite dialect). Double-quote table names with hyphens. Returns up to 1000 rows. " +
      "Hex values are auto-decoded: resource balances and troop counts are divided by RESOURCE_PRECISION (1e9) to give actual amounts. " +
      "Felt-encoded strings (name, guild_name) are decoded to readable text. Address/entity columns are left as hex strings.",
    inputSchema: z.object({
      toriiUrl: z.string().url().describe("Torii URL of the world to query"),
      sql: z.string().describe("SQL query (SQLite dialect). Double-quote table names with hyphens."),
    }),
    execute: async ({ toriiUrl, sql }) => {
      try {
        const conn = await connectTorii(toriiUrl);
        const limited = `SELECT * FROM (${sql.replace(/;\s*$/, "")}) LIMIT 1001`;
        const results = await executeToriiQuery(conn, limited);
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

  const getPlayers = tool({
    description:
      "Get all players with their structure counts, registered points, and guild membership. " +
      "Returns one row per player with: player_name, address, structure_count, registered_points, guild_name. " +
      "Use this for any question about player counts, leaderboards, structure counts, points, or guild membership.",
    inputSchema: z.object({
      toriiUrl: z.string().url().describe("Torii URL of the world to query"),
    }),
    execute: async ({ toriiUrl }) => {
      try {
        const conn = await connectTorii(toriiUrl);
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
        const results = await executeToriiQuery(conn, sql);
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
      toriiUrl: z.string().url().describe("Torii URL of the world to query"),
      playerName: z.string().optional().describe("Optional player name to filter by (e.g. 'boat'). If omitted, returns all armies."),
    }),
    execute: async ({ toriiUrl, playerName }) => {
      try {
        const conn = await connectTorii(toriiUrl);

        let addressFilter = "";
        if (playerName) {
          const target = playerName.toLowerCase();
          const names = await executeToriiQuery(conn, `SELECT name, address FROM "s1_eternum-AddressName"`);
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
        const results = await executeToriiQuery(conn, sql);
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
      toriiUrl: z.string().url().describe("Torii URL of the world to query"),
      playerName: z.string().optional().describe("Player name to center on (e.g. 'boat')"),
      relativeTo: z.enum(["structures", "troops"]).optional().describe("When using playerName: measure from structures (default) or armies"),
      coords: z.object({ x: z.number(), y: z.number() }).optional().describe("Exact coordinates in raw DB format (e.g. 1225670892, not relative). Get these from structure/explorer query results."),
      entityId: z.number().optional().describe("Entity ID of a structure or explorer to measure distance from"),
    }),
    execute: async ({ toriiUrl, playerName, relativeTo, coords, entityId }) => {
      try {
        const conn = await connectTorii(toriiUrl);

        let refPoints: Array<{ x: number; y: number; id: number | string }>;

        if (coords) {
          refPoints = [{ x: coords.x, y: coords.y, id: "coord" }];
        } else if (entityId != null) {
          const structRows = await executeToriiQuery(
            conn,
            `SELECT entity_id, "base.coord_x", "base.coord_y" FROM "s1_eternum-Structure" WHERE entity_id = ${entityId}`,
          );
          if (structRows.length > 0) {
            refPoints = [{ x: Number(structRows[0]["base.coord_x"]), y: Number(structRows[0]["base.coord_y"]), id: entityId }];
          } else {
            const explorerRows = await executeToriiQuery(
              conn,
              `SELECT explorer_id, "coord.x", "coord.y" FROM "s1_eternum-ExplorerTroops" WHERE explorer_id = ${entityId}`,
            );
            if (explorerRows.length > 0) {
              refPoints = [{ x: Number(explorerRows[0]["coord.x"]), y: Number(explorerRows[0]["coord.y"]), id: entityId }];
            } else {
              return { error: `Entity ${entityId} not found in structures or explorers.` };
            }
          }
        } else if (playerName) {
          const target = playerName.toLowerCase();
          const mode = relativeTo ?? "structures";

          const names = await executeToriiQuery(conn, `SELECT name, address FROM "s1_eternum-AddressName"`);
          const match = names.find((r) => decodePaddedFeltAscii(String(r.name)).toLowerCase() === target);
          if (!match) {
            const allNames = names.map((r) => decodePaddedFeltAscii(String(r.name))).filter(Boolean);
            return { error: `Player "${playerName}" not found. Available players: ${allNames.join(", ")}` };
          }
          const address = match.address as string;

          if (mode === "troops") {
            const playerTroops = await executeToriiQuery(
              conn,
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
              conn,
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
        const results = await executeToriiQuery(conn, sql);
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

  const ephemeral = { anthropic: { cacheControl: { type: "ephemeral" as const } } };
  const ephemeral1h = { anthropic: { cacheControl: { type: "ephemeral" as const, ttl: "1h" } } };

  const baseTools = { queryData, getSchema };
  const tools = isEternum
    ? { ...baseTools, getPlayers, getTroops, getNearbyTroops }
    : baseTools;

  // Add cache breakpoint to the last tool — caches system + tools as a prefix block with 1h TTL
  const toolNames = Object.keys(tools);
  const lastToolName = toolNames[toolNames.length - 1];
  (tools as Record<string, any>)[lastToolName] = {
    ...tools[lastToolName as keyof typeof tools],
    providerOptions: ephemeral1h,
  };

  console.error(`[agent] instructions length=${instructions.length} hash=${Buffer.from(instructions).toString("base64").slice(0, 20)}`);

  return new ToolLoopAgent({
    model: anthropic(process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001"),
    instructions,
    tools,
    stopWhen: stepCountIs(20),
    temperature: 0.1,
    prepareStep: ({ messages }) => ({
      messages: messages.map((msg, i) => {
        if (msg.role === "system") {
          // System prompt + schema: cache with 1h TTL (stable across requests)
          return { ...msg, providerOptions: { ...msg.providerOptions, ...ephemeral1h } };
        }
        if (i === messages.length - 1) {
          // Last message: cache the conversation prefix for next step
          return { ...msg, providerOptions: { ...msg.providerOptions, ...ephemeral } };
        }
        return msg;
      }),
    }),
  });
}
