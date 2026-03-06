export interface ToriiColumnInfo {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
}

export interface ToriiTableInfo {
  name: string;
  columns: ToriiColumnInfo[];
}

let toriiState: {
  baseUrl: string;
  tables: ToriiTableInfo[];
} | null = null;

const EXCLUDED_PREFIXES = ["sqlite_", "search_index", "_sqlx"];

function parseCreateTableSql(sql: string): ToriiColumnInfo[] {
  const columns: ToriiColumnInfo[] = [];
  const openParen = sql.indexOf("(");
  const closeParen = sql.lastIndexOf(")");
  if (openParen === -1 || closeParen === -1) return columns;

  const body = sql.substring(openParen + 1, closeParen);
  const parts = body.split(",");

  for (const part of parts) {
    const trimmed = part.trim();
    const colMatch =
      trimmed.match(/^"([^"]+)"\s+(\w+)(.*)$/i) ||
      trimmed.match(/^\[([^\]]+)\]\s+(\w+)(.*)$/i) ||
      trimmed.match(/^(\w+)\s+(\w+)(.*)$/i);
    if (!colMatch) continue;

    const name = colMatch[1] as string;
    const type = (colMatch[2] as string).toUpperCase();
    const rest = colMatch[3] ?? "";

    // Skip table-level constraints
    if (["PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT"].includes(name.toUpperCase())) continue;
    // Skip internal bookkeeping columns
    if (name.startsWith("internal_")) continue;

    columns.push({
      name,
      type,
      notnull: /NOT\s+NULL/i.test(rest),
      pk: /PRIMARY\s+KEY/i.test(rest),
    });
  }
  return columns;
}

async function toriiQuery(baseUrl: string, sql: string): Promise<Record<string, unknown>[]> {
  const url = `${baseUrl}/sql?query=${encodeURIComponent(sql)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const json = JSON.parse(text);
      message = json?.error?.message || json?.error || text;
    } catch {}
    throw new Error(`Torii query failed (${res.status}): ${message}`);
  }
  return res.json();
}

export async function connectTorii(baseUrl: string) {
  // Normalize: strip trailing slash and /sql?query= suffix if provided
  let url = baseUrl.replace(/\/+$/, "");
  url = url.replace(/\/sql\??.*$/, "").replace(/\/+$/, "");

  // Single query replaces 1 table-list + N PRAGMA queries
  const rows = await toriiQuery(url, `SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name`);
  const tables: ToriiTableInfo[] = [];
  for (const row of rows as Array<{ name: string; sql: string }>) {
    if (EXCLUDED_PREFIXES.some((p) => row.name.startsWith(p))) continue;
    tables.push({ name: row.name, columns: parseCreateTableSql(row.sql) });
  }

  toriiState = { baseUrl: url, tables };
  return { tables };
}

export function isToriiConnected(): boolean {
  return toriiState !== null;
}

export function getToriiState() {
  return toriiState;
}

export function disconnectTorii() {
  toriiState = null;
}

export async function executeToriiQuery(sql: string): Promise<Record<string, unknown>[]> {
  if (!toriiState) throw new Error("Torii not connected");

  const normalized = sql.trim().replace(/^\/\*[\s\S]*?\*\/\s*/, "");
  const firstKeyword = normalized.split(/\s+/)[0]?.toUpperCase();
  if (!firstKeyword || !["SELECT", "WITH", "DESCRIBE", "SHOW", "EXPLAIN", "PRAGMA"].includes(firstKeyword)) {
    throw new Error("Only read-only queries are allowed");
  }

  return toriiQuery(toriiState.baseUrl, sql);
}

export async function getToriiTableSchema(tableName: string) {
  if (!toriiState) throw new Error("Torii not connected");

  // Get columns from cached state
  const table = toriiState.tables.find((t) => t.name === tableName);
  const columns = table
    ? table.columns.map((c) => ({ name: c.name, type: c.type }))
    : [];

  // Get row count and sample rows live
  let rowCount = 0;
  try {
    const countResult = await toriiQuery(toriiState.baseUrl, `SELECT COUNT(*) as cnt FROM "${tableName}"`);
    rowCount = Number((countResult[0] as Record<string, unknown>)?.cnt ?? 0);
  } catch {}

  let sampleRows: Record<string, unknown>[] = [];
  try {
    const raw = await toriiQuery(toriiState.baseUrl, `SELECT * FROM "${tableName}" LIMIT 5`);
    sampleRows = raw.map((row) => {
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (!key.startsWith("internal_")) filtered[key] = value;
      }
      return filtered;
    });
  } catch {}

  return { columns, rowCount, sampleRows };
}
