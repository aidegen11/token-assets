// src/auto-config-bq.ts
import type { TokenLaunchConfig } from "./index";

/**
 * Bitquery V2 picker:
 * 1) Get *newest* Pump.fun mints in the last N minutes
 * 2) Get top movers by 5m (using Trading.Pairs 5m OHLC)
 * 3) Intersect by mint; pick the best that has a metadata URI
 */

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// Prefer HTTP (queries) endpoint. Streaming (wss) is for subscriptions.
const BQ_ENDPOINT =
  process.env.BITQUERY_HTTP_ENDPOINT?.trim() ||
  "https://graphql.bitquery.io";

const BQ_KEY = process.env.BITQUERY_API_KEY || "";

// --- helpers ------------------------------------------------------------

function normIpfs(uri: string) {
  if (!uri) return uri;
  if (uri.startsWith("ipfs://")) return uri;
  // common gateways → ipfs://CID
  const m =
    uri.match(/(?:ipfs:\/\/|\/ipfs\/|^ipfs\/)([a-z0-9]+(?:[a-z0-9]+))/i) ||
    uri.match(/([a-z0-9]{46,})/i);
  return m?.[1] ? `ipfs://${m[1]}` : uri;
}

async function bqFetch<T>(query: string, variables?: any): Promise<T> {
  if (!BQ_KEY) throw new Error("Missing BITQUERY_API_KEY");
  const r = await fetch(BQ_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // V2 accepts either header; send both to be safe.
      Authorization: `Bearer ${BQ_KEY}`,
      "X-API-KEY": BQ_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await r.text();
  let json: any;
  try { json = JSON.parse(text); } catch { throw new Error(`Bitquery bad JSON: ${text.slice(0, 300)}`); }
  if (!r.ok || json?.errors) {
    throw new Error(`Bitquery GraphQL error: ${JSON.stringify(json?.errors || text)}`);
  }
  return json.data as T;
}

// --- Bitquery V2 queries ------------------------------------------------

// A) Newest Pump.fun creates (V2; add network param)
const NEWEST_QUERY = /* GraphQL */ `
  query NewPumpCreates($minutes: Int!, $limit: Int!) {
    Solana(network: solana) {
      TokenSupplyUpdates(
        where: {
          Instruction: { Program: { Address: { is: "${PUMP_PROGRAM}" }, Method: { is: "create" } } }
          Block: { Time: { since_relative: { minutes_ago: $minutes } } }
        }
        orderBy: { descending: Block_Time }
        limit: { count: $limit }
      ) {
        TokenSupplyUpdate {
          Currency {
            Name
            Symbol
            MintAddress
            Uri
          }
        }
      }
    }
  }
`;

// B) Top movers by 5m using Trading.Pairs (V2).
// We request 5-minute candles (Interval.Duration=300) in the last ~10 minutes
// and compute Δ% = (close - open) / open * 100 on the client.
const TOP_5M_QUERY = /* GraphQL */ `
  query TopBy5m($limit: Int!, $sinceMinutes: Int!) {
    Trading {
      Pairs(
        limit: { count: $limit }
        limitBy: { count: 1, by: Token_Address }
        orderBy: { descending: Block_Time }  # latest first
        where: {
          Block: { Time: { since_relative: { minutes_ago: $sinceMinutes } } }
          Price: { IsQuotedInUsd: true }
          Market: { Network: { is: "Solana" }, Program: { is: "${PUMP_PROGRAM}" } }
          Interval: { Time: { Duration: { eq: 300 } } }  # 5m
        }
      ) {
        Token { Address Name Symbol }
        Price { Ohlc { Open Close } }
      }
    }
  }
`;

// --- mappers ------------------------------------------------------------

type NewestRow = { name?: string; symbol?: string; mint?: string; uri?: string };
type TopRow = { mint?: string; name?: string; symbol?: string; change5m?: number };

function parseNewest(data: any, limit: number): NewestRow[] {
  const rows = data?.Solana?.TokenSupplyUpdates ?? [];
  return rows.slice(0, limit).map((r: any) => {
    const c = r?.TokenSupplyUpdate?.Currency ?? {};
    return { name: c?.Name, symbol: c?.Symbol, mint: c?.MintAddress, uri: c?.Uri };
  });
}

function parseTop(data: any, limit: number): TopRow[] {
  const rows = data?.Trading?.Pairs ?? [];
  return rows.slice(0, limit).map((r: any) => {
    const t = r?.Token ?? {};
    const o = Number(r?.Price?.Ohlc?.Open ?? 0);
    const c = Number(r?.Price?.Ohlc?.Close ?? 0);
    const change = o > 0 ? ((c - o) / o) * 100 : 0;
    return { mint: t?.Address, name: t?.Name, symbol: t?.Symbol, change5m: change };
  });
}

// --- public builder -----------------------------------------------------

export async function buildConfigFromBitqueryPicker(params?: {
  newestCount?: number;        // default 30
  topCount?: number;           // default 50
  minutesWindow?: number;      // how far back for "newest" (default 10m)
  sinceMinutesTop?: number;    // how far back for "top" scan (default 10m)
  defaultInitialBuy?: number;
  defaultSlippage?: number;
  defaultPriorityFee?: number;
}): Promise<TokenLaunchConfig> {
  const {
    newestCount = Number(process.env.BQ_NEWEST_COUNT || 30),
    topCount = Number(process.env.BQ_TOP_COUNT || 50),
    minutesWindow = Number(process.env.BQ_NEWEST_MINUTES || 10),
    sinceMinutesTop = Number(process.env.BQ_TOP_SINCE_MINUTES || 10),
    defaultInitialBuy = 0.001,
    defaultSlippage = 5,
    defaultPriorityFee = 0,
  } = params || {};

  const [newestRes, topRes] = await Promise.all([
    bqFetch<any>(NEWEST_QUERY, { minutes: minutesWindow, limit: newestCount }),
    bqFetch<any>(TOP_5M_QUERY, { sinceMinutes: sinceMinutesTop, limit: topCount }),
  ]);

  const newest = parseNewest(newestRes, newestCount);
  const top = parseTop(topRes, topCount);

  if (!newest.length || !top.length) {
    throw new Error("Bitquery returned empty sets (newest/top).");
  }

  // Intersect by mint; pick highest 5m change among those new mints that have a URI
  const newestByMint = new Map(newest.map(n => [n.mint, n]));
  const intersected = top
    .filter(t => t.mint && newestByMint.has(t.mint))
    .sort((a, b) => (b.change5m! - a.change5m!));

  const best = intersected.find(x => newestByMint.get(x.mint!)?.uri);
  const fallback = newest.find(n => n.uri);

  const pick = best ? newestByMint.get(best.mint!) : fallback;
  if (!pick?.uri) throw new Error("No intersecting newest/top candidate with a metadata URI.");

  const name = (pick.name || "Auto Token").slice(0, 32);
  const symbol = (pick.symbol || "AUTO").slice(0, 10);
  const metadataUrl = normIpfs(pick.uri);

  return {
    name,
    symbol,
    metadataUrl,
    initialBuy: defaultInitialBuy,
    slippage: defaultSlippage,
    priorityFee: defaultPriorityFee,
  };
}
