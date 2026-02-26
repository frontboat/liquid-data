/**
 * Discovers active Eternum worlds across all chains.
 *
 * Returns: [{ name, chain, status, toriiUrl, worldAddress }, ...]
 */

import { decodePaddedFeltAscii } from "./decode-hex.js";

export type Chain = "slot" | "sepolia" | "mainnet";
export type GameStatus = "upcoming" | "ongoing" | "ended" | "unknown";

export interface DiscoveredWorld {
  name: string;
  chain: Chain;
  status: GameStatus;
  toriiUrl: string;
  worldAddress: string | null;
}

export interface DiscoverWorldsOptions {
  chain?: Chain;
  apiBase?: string;
}

// --- Hex / felt encoding ---

function nameToPaddedFelt(name: string): string {
  const bytes = new TextEncoder().encode(name);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `0x${hex.padStart(64, "0")}`;
}

// --- Row helpers ---

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function extractNameFelt(row: Record<string, unknown>): string | null {
  const direct = row.name ?? row["data.name"];
  if (typeof direct === "string") return direct;

  const data = asRecord(row.data);
  if (data) {
    const nested = data.name;
    if (typeof nested === "string") return nested;
  }
  return null;
}

// --- Fetch helpers ---

async function fetchFactoryRows(baseUrl: string, query: string): Promise<Record<string, unknown>[]> {
  const url = `${baseUrl}?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Factory query failed: ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("Unexpected payload");
  return rows as Record<string, unknown>[];
}

function extractWorldAddress(row: Record<string, unknown>): string | null {
  for (const key of ["address", "contract_address", "world_address", "worldAddress"]) {
    const v = row[key] ?? row[`data.${key}`];
    if (typeof v === "string" && v) return v;
  }
  const data = asRecord(row.data);
  if (data) {
    for (const key of ["address", "contract_address", "world_address", "worldAddress"]) {
      const v = data[key];
      if (typeof v === "string" && v) return v;
    }
  }
  return null;
}

async function resolveWorldAddress(factoryUrls: string[], worldName: string): Promise<string | null> {
  const paddedName = nameToPaddedFelt(worldName);
  const query = `SELECT * FROM [wf-WorldDeployed] WHERE name = "${paddedName}" LIMIT 1;`;
  for (const baseUrl of factoryUrls) {
    try {
      const rows = await fetchFactoryRows(baseUrl, query);
      const first = rows[0];
      if (first) return extractWorldAddress(first);
    } catch {
      // try next
    }
  }
  return null;
}

// --- Factory discovery ---

async function discoverSlotFactories(apiBase: string): Promise<string[]> {
  const suffixes = "abcdefghijklmnopqrstuvwxyz".split("");
  const probe = async (suffix: string): Promise<string | null> => {
    const url = `${apiBase}/x/eternum-factory-slot-${suffix}/torii/sql`;
    try {
      const res = await fetch(`${url}?query=${encodeURIComponent("SELECT 1 LIMIT 1;")}`, {
        signal: AbortSignal.timeout(3_000),
      });
      return res.ok ? url : null;
    } catch {
      return null;
    }
  };
  const results = await Promise.all(suffixes.map(probe));
  return results.filter((u): u is string => u !== null);
}

let cachedSlotFactories: string[] | null = null;

async function getFactorySqlBaseUrls(chain: Chain, apiBase: string): Promise<string[]> {
  switch (chain) {
    case "mainnet":
      return [`${apiBase}/x/eternum-factory-mainnet/torii/sql`];
    case "sepolia":
      return [`${apiBase}/x/eternum-factory-sepolia/torii/sql`];
    case "slot":
      if (!cachedSlotFactories) cachedSlotFactories = await discoverSlotFactories(apiBase);
      return cachedSlotFactories;
  }
}

// --- Torii / world status ---

async function isToriiAvailable(toriiBaseUrl: string): Promise<boolean> {
  try {
    const q = "SELECT contract_address FROM contracts WHERE contract_type = 'WORLD' LIMIT 1;";
    const res = await fetch(`${toriiBaseUrl}/sql?query=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function parseMaybeHexToNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    try {
      if (v.startsWith("0x") || v.startsWith("0X")) return Number(BigInt(v));
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

function deriveGameStatus(startMainAt: number | null, endAt: number | null): GameStatus {
  const nowSec = Math.floor(Date.now() / 1000);
  if (endAt != null && endAt > 0 && nowSec > endAt) return "ended";
  if (startMainAt != null && startMainAt > 0 && nowSec >= startMainAt) return "ongoing";
  if (startMainAt != null && startMainAt > 0 && nowSec < startMainAt) return "upcoming";
  return "unknown";
}

const WORLD_CONFIG_QUERY = `SELECT "season_config.start_main_at" AS start_main_at, "season_config.end_at" AS end_at FROM "s1_eternum-WorldConfig" LIMIT 1;`;

async function checkWorldAvailability(worldName: string, apiBase: string): Promise<{ available: boolean; status: GameStatus }> {
  const toriiBaseUrl = `${apiBase}/x/${worldName}/torii`;
  const available = await isToriiAvailable(toriiBaseUrl);
  if (!available) return { available: false, status: "unknown" };

  try {
    const url = `${toriiBaseUrl}/sql?query=${encodeURIComponent(WORLD_CONFIG_QUERY)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { available: true, status: "unknown" };
    const rows = (await res.json()) as Record<string, unknown>[];
    const row = rows[0];
    if (!row) return { available: true, status: "unknown" };

    const startMainAt = parseMaybeHexToNumber(row.start_main_at);
    const endAt = parseMaybeHexToNumber(row.end_at);
    return { available: true, status: deriveGameStatus(startMainAt, endAt) };
  } catch {
    return { available: true, status: "unknown" };
  }
}

// --- Per-chain discovery ---

async function discoverWorldsForChain(chain: Chain, apiBase: string): Promise<DiscoveredWorld[]> {
  const factoryUrls = await getFactorySqlBaseUrls(chain, apiBase);
  if (factoryUrls.length === 0) return [];

  const query = `SELECT name FROM [wf-WorldDeployed] ORDER BY internal_created_at DESC LIMIT 1000;`;
  const seen = new Set<string>();
  const candidates: { name: string; chain: Chain }[] = [];

  const allRows = await Promise.all(
    factoryUrls.map(async (url) => {
      try {
        return await fetchFactoryRows(url, query);
      } catch {
        return [];
      }
    }),
  );

  for (const rows of allRows) {
    for (const row of rows) {
      const nameFelt = extractNameFelt(row);
      if (!nameFelt) continue;
      const name = decodePaddedFeltAscii(nameFelt);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      candidates.push({ name, chain });
    }
  }

  const checks = await Promise.all(
    candidates.map(async (c) => {
      const [{ status }, worldAddress] = await Promise.all([
        checkWorldAvailability(c.name, apiBase),
        resolveWorldAddress(factoryUrls, c.name),
      ]);
      const toriiUrl = `${apiBase}/x/${c.name}/torii`;
      return { ...c, status, toriiUrl, worldAddress };
    }),
  );

  return checks
    .filter((w) => w.status === "upcoming" || w.status === "ongoing")
    .map(({ name, chain, status, toriiUrl, worldAddress }) => ({ name, chain, status, toriiUrl, worldAddress }));
}

// --- Cache ---

let cachedWorlds: { worlds: DiscoveredWorld[]; timestamp: number } | null = null;
const CACHE_TTL_MS = 60_000;

// --- Exported functions ---

export async function listWorlds(options?: DiscoverWorldsOptions): Promise<DiscoveredWorld[]> {
  const apiBase = options?.apiBase || process.env.CARTRIDGE_API_BASE || "https://api.cartridge.gg";

  // Use cache when no chain filter is applied
  if (!options?.chain && cachedWorlds && Date.now() - cachedWorlds.timestamp < CACHE_TTL_MS) {
    return cachedWorlds.worlds;
  }

  const chains: Chain[] = options?.chain ? [options.chain] : ["slot", "sepolia", "mainnet"];
  const results = await Promise.all(chains.map((c) => discoverWorldsForChain(c, apiBase)));
  const worlds = results.flat();

  if (!options?.chain) {
    cachedWorlds = { worlds, timestamp: Date.now() };
  }

  return worlds;
}

export async function findFirstOngoingWorld(options?: DiscoverWorldsOptions): Promise<DiscoveredWorld | null> {
  const worlds = await listWorlds(options);
  return worlds.find((w) => w.status === "ongoing") ?? worlds[0] ?? null;
}
