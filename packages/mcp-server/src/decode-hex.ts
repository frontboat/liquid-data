/**
 * Decodes hex values in Torii query results.
 *
 * - Converts 0x-prefixed hex strings to numbers
 * - Divides resource balance and troop count columns by RESOURCE_PRECISION (1e9)
 * - Leaves address/entity/owner columns untouched
 */

const RESOURCE_PRECISION = 1_000_000_000;

/** Columns that are identifiers — hex but should stay as strings */
const IDENTIFIER_PATTERNS = [
  "address",
  "owner",
  "entity_id",
  "attacker_id",
  "defender_id",
  "guild_id",
  "member",
  "contract_address",
  "world_address",
  "player_address",
  "taker_id",
  "maker_id",
];

/** Columns where the raw hex value should be divided by RESOURCE_PRECISION */
const PRECISION_PATTERNS = [
  "_BALANCE",
  "_count", // troop guard counts
  ".count", // troop counts via dot notation
];

function isIdentifierColumn(col: string): boolean {
  const lower = col.toLowerCase();
  return IDENTIFIER_PATTERNS.some((p) => lower === p || lower.endsWith(`.${p}`) || lower.endsWith(`_${p}`));
}

function needsPrecisionDivision(col: string): boolean {
  return PRECISION_PATTERNS.some((p) => col.includes(p));
}

function decodeHexValue(value: string, col: string): string | number {
  if (isIdentifierColumn(col)) return value;

  try {
    const n = BigInt(value);
    if (needsPrecisionDivision(col)) {
      return Number(n / BigInt(RESOURCE_PRECISION));
    }
    // Safe integer range check
    if (n >= Number.MIN_SAFE_INTEGER && n <= Number.MAX_SAFE_INTEGER) {
      return Number(n);
    }
    return n.toString(10);
  } catch {
    return value;
  }
}

export function decodeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const decoded: Record<string, unknown> = {};
    for (const [col, value] of Object.entries(row)) {
      if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) {
        decoded[col] = decodeHexValue(value, col);
      } else {
        decoded[col] = value;
      }
    }
    return decoded;
  });
}
