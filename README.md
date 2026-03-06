# Data Explorer

An AI-powered data explorer for structured data. Upload a CSV or connect to a [Torii](https://github.com/dojoengine/torii) database and ask questions in natural language. The agent queries your data, generates answers, and renders interactive dashboards.

## Quick Start

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000), then either upload a file or connect to a Torii URL.

## Features

- **CSV uploads** — Drop any CSV and query it with DuckDB
- **Torii databases** — Connect to any Torii instance and query on-chain data (SQLite dialect)
- **Natural language** — Ask questions in plain English, the agent writes SQL for you
- **Auto-decoding** — Hex values, felt-encoded strings, and scaled balances are decoded automatically
- **Rich dashboards** — Results render as tables, charts, metrics, and cards

## Project Structure

```
app/                    Next.js app (pages, API routes)
lib/
  agent.ts              UI agent (DuckDB + Torii modes)
  decode-hex.ts         Hex/felt auto-decoding for query results
  torii.ts              Torii connection and query utilities
  duckdb.ts             DuckDB for uploaded CSV files
packages/mcp-server/    Eternum MCP server (see its own README)
```

## Environment Variables

```
ANTHROPIC_API_KEY     # Anthropic API key
ANTHROPIC_MODEL       # Model override (default: claude-haiku-4-5-20251001)
AUTH_PASSWORD          # Optional auth password
AUTH_SECRET            # Session secret
```
