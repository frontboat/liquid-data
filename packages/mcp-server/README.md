# Eternum Explorer MCP Server

An MCP server for querying [Eternum](https://eternum.realms.world) on-chain game data. Discovers active game worlds, connects to their Torii databases, and answers natural-language questions about players, structures, troops, resources, guilds, and more.

## Install

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

## Tools

### `list-worlds`

Discover active Eternum worlds across chains (slot, sepolia, mainnet). Returns world name, chain, status, Torii URL, and world address.

### `query-world`

Ask a natural-language question about a world's on-chain data. Optionally pass a `torii_url` to target a specific world, or omit it to let the agent auto-discover active worlds.

**Examples:**
```
"Who has the largest army?"
"What are the top 10 guilds by member count?"
"How many realms are there?"
"Show me all hyperstructure shareholders"
```

## How It Works

The server wraps an inner AI agent (Claude Haiku 4.5) that has access to three tools:

1. **`listTables`** — browse available tables at a Torii URL
2. **`getSchema`** — inspect columns, types, row count, and sample rows
3. **`queryData`** — execute SQL (SQLite dialect) against the database

Each tool takes an explicit `toriiUrl` parameter — there is no shared connection state. Query results are auto-decoded: hex values become numbers, resource balances and troop counts are divided by `RESOURCE_PRECISION` (1e9), and felt-encoded strings (player names, guild names) are decoded to readable text.

## Run Locally

```bash
pnpm build
pnpm start                 # stdio mode (default)
TRANSPORT=http pnpm start  # HTTP mode on :3001
```

## Environment Variables

```
ANTHROPIC_API_KEY     # Anthropic API key
ANTHROPIC_MODEL       # Model override (default: claude-haiku-4-5-20251001)
TRANSPORT             # "stdio" (default) or "http"
PORT                  # HTTP port (default: 3001)
CARTRIDGE_API_BASE    # Cartridge API base URL (default: https://api.cartridge.gg)
```
