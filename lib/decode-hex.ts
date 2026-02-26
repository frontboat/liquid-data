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

/**
 * Columns where the raw hex value should be divided by RESOURCE_PRECISION.
 * Verified against live data — only these are confirmed precision-scaled:
 *   - *_BALANCE: resource balances (WHEAT_BALANCE, STONE_BALANCE, etc.)
 *   - troop_guards.*.count / troops.count: troop unit counts
 *   - weight.weight / weight.capacity: resource weight fields
 *   - *.output_amount_left / *.production_rate: resource production (u128, precision-scaled)
 */
function needsPrecisionDivision(col: string): boolean {
  if (col.includes("_BALANCE")) return true;
  if (col.startsWith("weight.")) return true;
  if (col.endsWith(".output_amount_left") || col.endsWith(".production_rate")) return true;
  // Only troop-related .count columns — not realm_count_config.count etc.
  if (col.endsWith(".count") && (col.startsWith("troop") || col === "troops.count")) return true;
  return false;
}

function isIdentifierColumn(col: string): boolean {
  const lower = col.toLowerCase();
  return IDENTIFIER_PATTERNS.some((p) => lower === p || lower.endsWith(`.${p}`) || lower.endsWith(`_${p}`));
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

export function decodeRows(
  rows: Record<string, unknown>[],
  opts?: { stripZeros?: boolean },
): Record<string, unknown>[] {
  const stripZeros = opts?.stripZeros ?? false;
  return rows.map((row) => {
    const decoded: Record<string, unknown> = {};
    for (const [col, value] of Object.entries(row)) {
      if (col.startsWith("internal_")) continue;
      if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) {
        decoded[col] = decodeHexValue(value, col);
      } else {
        decoded[col] = value;
      }
    }
    if (stripZeros) {
      for (const key of Object.keys(decoded)) {
        const val = decoded[key];
        if (val === 0 || val === "0" || (typeof val === "string" && /^0x0+$/.test(val))) {
          delete decoded[key];
        }
      }
    }
    return decoded;
  });
}
