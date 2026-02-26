import { DuckDBInstance } from "@duckdb/node-api";

let instance: DuckDBInstance | null = null;
let connection: Awaited<ReturnType<DuckDBInstance["connect"]>> | null = null;

async function getConnection() {
  if (!connection) {
    instance = await DuckDBInstance.create(":memory:");
    connection = await instance.connect();
  }
  return connection;
}

export type FileFormat = "csv" | "json";

function detectFormat(filename: string, content: string): FileFormat {
  if (filename.endsWith(".json")) return "json";
  if (filename.endsWith(".csv") || filename.endsWith(".tsv")) return "csv";
  // Sniff content
  const trimmed = content.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return "json";
  return "csv";
}

export async function initDatabase(
  content: string,
  tableName: string = "data",
  filename: string = "upload.csv",
) {
  const conn = await getConnection();
  await conn.run(`DROP TABLE IF EXISTS ${tableName}`);

  const format = detectFormat(filename, content);
  const reader = format === "json" ? "read_json_auto" : "read_csv_auto";

  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");
  const ext = format === "json" ? ".json" : ".csv";
  const tmpFile = path.join(os.tmpdir(), `duckdb_upload_${Date.now()}${ext}`);
  fs.writeFileSync(tmpFile, content, "utf-8");

  try {
    await conn.run(`CREATE TABLE ${tableName} AS SELECT * FROM ${reader}('${tmpFile}')`);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

export async function executeQuery(sql: string): Promise<Record<string, unknown>[]> {
  const conn = await getConnection();
  const result = await conn.run(sql);

  const rows: Record<string, unknown>[] = [];
  const reader = await result.getRows();

  for (const row of reader) {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < result.columnCount; i++) {
      const name = result.columnName(i);
      const val = row[i];
      obj[name] = typeof val === "bigint" ? Number(val) : val;
    }
    rows.push(obj);
  }

  return rows;
}

export async function getTableSchema(tableName: string = "data") {
  const conn = await getConnection();

  // Get column info
  const columnsResult = await conn.run(`DESCRIBE ${tableName}`);
  const columns: Array<{ name: string; type: string }> = [];
  for (const row of await columnsResult.getRows()) {
    columns.push({
      name: String(row[0]),
      type: String(row[1]),
    });
  }

  // Get row count
  const countResult = await conn.run(`SELECT COUNT(*) as cnt FROM ${tableName}`);
  let rowCount = 0;
  for (const row of await countResult.getRows()) {
    rowCount = Number(row[0]);
  }

  // Get sample rows
  const sampleResult = await executeQuery(`SELECT * FROM ${tableName} LIMIT 5`);

  return { columns, rowCount, sampleRows: sampleResult };
}

export async function isDataLoaded(): Promise<boolean> {
  if (!connection) return false;
  try {
    await connection.run("SELECT 1 FROM data LIMIT 1");
    return true;
  } catch {
    return false;
  }
}
