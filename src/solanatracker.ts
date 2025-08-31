// src/solanatracker.ts

export type STTimeframe =
  | "5m" | "15m" | "30m" | "1h" | "2h" | "3h" | "4h" | "5h" | "6h" | "12h" | "24h";

const ST_BASE = "https://data.solanatracker.io";
const ST_KEY = process.env.ST_API_KEY ?? "";

/** External shape your app consumes */
export interface STTrendingRow {
  name: string;
  symbol: string;
  mintAddress: string;
  uri?: string;
  image?: string;
  description?: string;
}

/** Raw API shapes */
type STTrendingItem = {
  token?: {
    mint?: string;
    name?: string;
    symbol?: string;
    uri?: string;
    image?: string;
    description?: string;
  };
};

type STTrendingRespMaybeWrapped =
  | STTrendingItem[]
  | { tokens?: STTrendingItem[] };

type STTokenResp = {
  token?: {
    mint?: string;
    name?: string;
    symbol?: string;
    uri?: string;
    image?: string;
    description?: string;
  };
};

function coerceLimit(n?: number): number {
  const envRaw = process.env.ST_LIMIT;
  const envNum = envRaw ? parseInt(envRaw, 10) : NaN;
  const base = Number.isFinite(envNum) ? envNum : (typeof n === "number" ? n : 40);
  return Math.max(1, Math.min(100, base)); // cap between 1 and 100
}

async function stFetch<T>(path: string): Promise<T> {
  if (!ST_KEY) throw new Error("Missing ST_API_KEY");
  const r = await fetch(`${ST_BASE}${path}`, {
    headers: { "x-api-key": ST_KEY, accept: "application/json" },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`SolanaTracker HTTP ${r.status} ${text}`);
  return JSON.parse(text) as T;
}

/** GET /tokens/trending or /tokens/trending/{timeframe} */
export async function stGetTrending(
  timeframe?: STTimeframe,
  limit?: number
): Promise<STTrendingRow[]> {
  const effLimit = coerceLimit(limit);
  const path = timeframe ? `/tokens/trending/${timeframe}` : `/tokens/trending`;
  const json = await stFetch<STTrendingRespMaybeWrapped>(path);

  const rows: STTrendingItem[] = Array.isArray(json) ? json : (json.tokens ?? []);
  console.log(
    `SolanaTracker trending: ${rows.length} rows (${Array.isArray(json) ? "array" : "wrapped"}), using limit=${effLimit}`
  );

  return rows.slice(0, effLimit).map<STTrendingRow>((row) => {
    const t = row.token ?? {};
    return {
      name: t.name ?? "",
      symbol: t.symbol ?? "",
      mintAddress: t.mint ?? "",
      uri: t.uri,
      image: t.image,
      description: t.description,
    };
  });
}

/** Fallback: GET /tokens/{mint} to fetch uri (and image) if missing */
export async function stGetTokenByMint(mint: string): Promise<STTrendingRow> {
  const json = await stFetch<STTokenResp>(`/tokens/${mint}`);
  const t = json.token ?? {};
  return {
    name: t.name ?? "",
    symbol: t.symbol ?? "",
    mintAddress: t.mint ?? mint,
    uri: t.uri,
    image: t.image,
    description: t.description,
  };
}
