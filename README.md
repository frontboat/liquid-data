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

## Prompt Caching

Both the UI agent and MCP server use Anthropic's prompt caching to reduce cost and latency. Caching is implemented at the `fetch` layer — the `createAnthropic` fetch interceptor injects `cache_control` directly into the Anthropic API request body, bypassing the Vercel AI SDK's `providerOptions` (which doesn't reliably translate to the API for system messages).

Three cache breakpoints per request (of 4 max):

| # | Target | TTL | Purpose |
|---|--------|-----|---------|
| 1 | Last tool definition | 1h | Tool definitions never change within a session |
| 2 | Last system prompt block | 1h | Instructions + schema stable per connection |
| 3 | Last message content block | 5min | Conversation prefix grows each tool-loop step |

**Results** (MCP server, Haiku 4.5):
- 45% cheaper per request vs no caching
- 86% cache hit rate (up from 13% with AI Gateway auto-caching)
- ~14.7k token tools+system prefix cached at 1h, refreshed on every read

A Railway Function cron job (`*/50 * * * *`) can keep the 1h cache warm between organic requests — a cache read ($0.0015) is 20x cheaper than a cold rewrite ($0.0295).

## Environment Variables

```
ANTHROPIC_API_KEY     # Anthropic API key
ANTHROPIC_MODEL       # Model override (default: claude-haiku-4-5-20251001)
AUTH_PASSWORD          # Optional auth password
AUTH_SECRET            # Session secret
```
