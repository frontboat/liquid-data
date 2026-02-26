# Eternum Explorer

A data explorer for [Eternum](https://eternum.realms.world) — an on-chain strategy game built on Starknet. Upload CSV data or connect to a live Torii instance and ask questions in natural language.

Also available as an MCP server for Claude Code, Cursor, and VS Code.

## Quick Start

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000), then either upload a file or connect to a Torii URL.

## MCP Server

The MCP server exposes two tools:

- **`list-worlds`** — Discover active Eternum worlds across chains (slot, sepolia, mainnet)
- **`query-world`** — Ask natural-language questions about a world's on-chain data

### Install

**Claude Code:**
```bash
claude mcp add eternum-explorer --transport http https://asktorii.com/mcp
```

**Cursor** (`.cursor/mcp.json`):
```json
{ "mcpServers": { "eternum-explorer": { "url": "https://asktorii.com/mcp" } } }
```

**VS Code** (`.vscode/mcp.json`):
```json
{ "servers": { "eternum-explorer": { "type": "http", "url": "https://asktorii.com/mcp" } } }
```

### Run locally

```bash
cd packages/mcp-server
pnpm build
pnpm start          # stdio mode (default)
TRANSPORT=http pnpm start  # HTTP mode on :3001
```

## Project Structure

```
app/                    Next.js app (pages, API routes)
lib/
  agent.ts              UI agent (DuckDB + Torii modes)
  list-worlds.ts        World discovery module
  decode-hex.ts         Hex auto-decoding for query results
  torii.ts              Torii connection/query utilities
  duckdb.ts             DuckDB for uploaded files
packages/mcp-server/
  src/
    index.ts            MCP server + tool registration
    agent.ts            Inner query agent (ToolLoopAgent)
    query-world.ts      Query handler
    list-worlds.ts      World discovery module
    decode-hex.ts       Hex auto-decoding for query results
    torii.ts            Torii connection/query utilities
```

## How It Works

The agent uses a tool loop to answer questions:

1. **`listTables`** — browse available tables
2. **`getSchema`** — inspect columns, types, sample rows
3. **`queryData`** — run SQL (SQLite dialect for Torii, DuckDB for uploads)

Query results are auto-decoded: hex values are converted to numbers, and resource balances / troop counts are divided by `RESOURCE_PRECISION` (1e9) to return actual game amounts.

## Environment Variables

```
AI_GATEWAY_API_KEY    # Vercel AI Gateway key
AI_GATEWAY_MODEL      # Model override (default: anthropic/claude-haiku-4.5)
AUTH_PASSWORD          # Optional auth password
AUTH_SECRET            # Session secret
CARTRIDGE_API_BASE    # Cartridge API base URL (default: https://api.cartridge.gg)
```
