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

  // Fetch table list
  const tables = await toriiQuery(url, `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`);
  const tableNames = (tables as Array<{ name: string }>)
    .map((t) => t.name)
    .filter((name) => !EXCLUDED_PREFIXES.some((p) => name.startsWith(p)));

  // Fetch schemas in parallel (batches of 15)
  const result: ToriiTableInfo[] = [];
  for (let i = 0; i < tableNames.length; i += 15) {
    const batch = tableNames.slice(i, i + 15);
    const schemas = await Promise.all(
      batch.map(async (name) => {
        try {
          const cols = await toriiQuery(url, `PRAGMA table_info("${name}")`);
          return {
            name,
            columns: (cols as Array<{ name: string; type: string; notnull: number; pk: number }>).map((c) => ({
              name: c.name,
              type: c.type,
              notnull: Boolean(c.notnull),
              pk: Boolean(c.pk),
            })),
          };
        } catch {
          return { name, columns: [] };
        }
      }),
    );
    result.push(...schemas);
  }

  toriiState = { baseUrl: url, tables: result };
  return { tables: result };
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
    sampleRows = await toriiQuery(toriiState.baseUrl, `SELECT * FROM "${tableName}" LIMIT 5`);
  } catch {}

  return { columns, rowCount, sampleRows };
}
