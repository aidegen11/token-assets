// src/bitquery.ts
// Bitquery v2 helpers (GraphQL endpoint: https://graphql.bitquery.io)

const BQ_URL = process.env.BITQUERY_ENDPOINT || "https://graphql.bitquery.io";
const BQ_TOKEN =
  process.env.BITQUERY_API_KEY || process.env.BITQUERY_TOKEN || "";

// --- core fetch ---
export async function bqFetchGql<T>(
  operationName: string,
  query: string,
  variables?: Record<string, any>
): Promise<T> {
  if (!BQ_TOKEN) throw new Error("Missing BITQUERY_API_KEY env var.");
  const res = await fetch(BQ_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Bitquery v2: use Authorization Bearer (not X-API-KEY)
      Authorization: `Bearer ${BQ_TOKEN}`,
    },
    body: JSON.stringify({ operationName, query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Bitquery HTTP ${res.status} ${text}`);
  const json = JSON.parse(text);
  if (json.errors) throw new Error(`Bitquery GraphQL error: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

// --- tiny JSON fetcher for Metaplex URIs (ipfs/http) ---
export async function fetchMetaplexJson(uri: string): Promise<{
  name?: string; symbol?: string; description?: string; image?: string;
}> {
  const u = uri.startsWith("ipfs://")
    ? `https://ipfs.io/ipfs/${uri.replace(/^ipfs:\/\//, "")}`
    : uri;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`fetch metadata ${r.status}`);
  return (await r.json()) as any;
}

// 1) New Pump.fun mints observed recently (uses v2 “Solana.TokenSupplyUpdates”)
export async function bqGetNewPumpCreates(
  minutes = 30,
  limit = 50
): Promise<Array<{ mint: string; uri?: string; name?: string; symbol?: string; time?: string }>> {
  const op = "NewPumpCreates";
  const q = /* GraphQL */ `
    query ${op}($minutes: Int!, $limit: Int!) {
      Solana {
        TokenSupplyUpdates(
          limit: { count: $limit }
          orderBy: { descending: Block_Time }
          where: {
            Block: { Time: { since_relative: { minutes_ago: $minutes } } }
            Instruction: {
              Program: {
                Address: { is: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" }
                Method: { is: "create" }
              }
            }
          }
        ) {
          Block { Time }
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
  type R = {
    Solana: {
      TokenSupplyUpdates: Array<{
        Block: { Time: string };
        TokenSupplyUpdate: {
          Currency: { Name?: string; Symbol?: string; MintAddress: string; Uri?: string };
        };
      }>;
    };
  };
  const data = await bqFetchGql<R>(op, q, { minutes, limit });
  const rows = data?.Solana?.TokenSupplyUpdates ?? [];
  return rows.map((r) => ({
    mint: r.TokenSupplyUpdate.Currency.MintAddress,
    uri: r.TokenSupplyUpdate.Currency.Uri || undefined,
    name: r.TokenSupplyUpdate.Currency.Name || undefined,
    symbol: r.TokenSupplyUpdate.Currency.Symbol || undefined,
    time: r.Block?.Time,
  }));
}

// 2) Top Pump.fun tokens by 5-minute market-cap change (v2 example uses DEXTradeByTokens)
export async function bqTopPumpBy5mChange(
  limit = 50,
  hoursBack = 6
): Promise<Array<{ mint: string; name?: string; symbol?: string; change5m?: number }>> {
  const op = "TopBy5m";
  const q = /* GraphQL */ `
    query ${op}($limit: Int!, $hours: Int!) {
      Solana {
        DEXTradeByTokens(
          limit: { count: $limit }
          orderBy:{ descendingByField: "Marketcap_Change_5min" }
          where: {
            Trade: { Dex: { ProgramAddress: { is: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" } } }
            Transaction: { Result: { Success: true } }
            Block: { Time: { since_relative: { hours_ago: $hours } } }
          }
        ) {
          Trade {
            Currency { Name Symbol MintAddress }
            Price_5min_ago: PriceInUSD(minimum: Block_Time if: { Block: { Time: { since_relative: { minutes_ago: 5 } } } })
            CurrentPrice: PriceInUSD(maximum: Block_Time)
          }
          Marketcap_Change_5min: calculate(
            expression: "(($Trade_CurrentPrice - $Trade_Price_5min_ago) / $Trade_Price_5min_ago) * 100"
          )
        }
      }
    }
  `;
  type R = {
    Solana: {
      DEXTradeByTokens: Array<{
        Trade: {
          Currency: { Name?: string; Symbol?: string; MintAddress: string };
          Price_5min_ago?: number;
          CurrentPrice?: number;
        };
        Marketcap_Change_5min?: number;
      }>;
    };
  };
  const data = await bqFetchGql<R>(op, q, { limit, hours: hoursBack });
  const rows = data?.Solana?.DEXTradeByTokens ?? [];
  return rows.map((r) => ({
    mint: r.Trade.Currency.MintAddress,
    name: r.Trade.Currency.Name || undefined,
    symbol: r.Trade.Currency.Symbol || undefined,
    change5m: r.Marketcap_Change_5min ?? undefined,
  }));
}

// 3) Utility: normalize ipfs-forwarder URLs to ipfs://
export function normalizeUri(u?: string): string | undefined {
  if (!u) return u;
  if (u.startsWith("ipfs://")) return u;
  const m = u.match(/ipfs\/([A-Za-z0-9]+)$/) || u.match(/ipfs\/(baf[^\s/]+)/);
  if (m) return `ipfs://${m[1]}`;
  // also accept direct gateways like https://ipfs.io/ipfs/<cid>
  const g = u.match(/https?:\/\/[^/]*ipfs[^/]*\/ipfs\/([^/?#]+)/);
  if (g) return `ipfs://${g[1]}`;
  return u;
}
