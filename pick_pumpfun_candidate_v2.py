#!/usr/bin/env python3
# Requires: pip install requests
import os, sys, json, argparse, requests

ENDPOINT = os.getenv("BQ_ENDPOINT", "https://streaming.bitquery.io/eap")
BEARER   = os.getenv("BITQUERY_ORY_TOKEN") or os.getenv("BQ_ORY_TOKEN") or os.getenv("BITQUERY_API_KEY") or ""

PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"

NEWEST_QUERY = """
query NewPumpCreates($minutes:Int!, $limit:Int!) {
  Solana {
    TokenSupplyUpdates(
      where:{
        Instruction:{ Program:{ Address:{ is: "%s" }, Method:{ is:"create" } } }
        Block:{ Time:{ since_relative:{ minutes_ago:$minutes } } }
      }
      orderBy:{ descending: Block_Time }
      limit:{ count:$limit }
    ){
      TokenSupplyUpdate{
        Currency{ MintAddress Name Symbol Uri }
      }
    }
  }
}
""" % PUMP_PROGRAM

TOP_5M_QUERY_HOURS = """
query TopBy5m($hours:Int!, $limit:Int!) {
  Solana {
    DEXTradeByTokens(
      limit:{ count:$limit }
      orderBy:{ descendingByField:"Marketcap_Change_5min" }
      where:{
        Trade:{ Dex:{ ProgramAddress:{ is:"%s" } } }
        Transaction:{ Result:{ Success:true } }
        Block:{ Time:{ since_relative:{ hours_ago:$hours } } }
      }
    ){
      Trade{
        Currency{ MintAddress Name Symbol }
        Price_5min_ago: PriceInUSD(minimum: Block_Time, if:{ Block:{ Time:{ since_relative:{ minutes_ago:5 } } } })
        CurrentPrice:   PriceInUSD(maximum: Block_Time)
      }
      Marketcap_Change_5min: calculate(expression: "(($Trade_CurrentPrice - $Trade_Price_5min_ago) / $Trade_Price_5min_ago) * 100")
    }
  }
}
""" % PUMP_PROGRAM

def gql(query: str, variables: dict) -> dict:
    if not BEARER.startswith("ory_at_"):
        raise SystemExit("❌ Missing ORY bearer: set BITQUERY_ORY_TOKEN=ory_at_…")
    r = requests.post(
        ENDPOINT,
        headers={"Content-Type":"application/json","Authorization":f"Bearer {BEARER}"},
        json={"query": query, "variables": variables},
        timeout=60
    )
    txt = r.text
    try:
        data = r.json()
    except Exception:
        raise SystemExit(f"HTTP {r.status_code}\n{txt[:800]}")
    if r.status_code != 200 or "errors" in data:
        raise SystemExit(f"Bitquery GraphQL error: {json.dumps(data.get('errors', txt), ensure_ascii=False)}")
    return data["data"]

def norm_ipfs(uri: str | None) -> str | None:
    if not uri: return uri
    if uri.startswith("ipfs://"): return uri
    import re
    m = re.search(r'(?:ipfs://|/ipfs/|ipfs/)([a-zA-Z0-9]+)', uri)
    return f"ipfs://{m.group(1)}" if m else uri

def pick_candidate(newest_minutes: int, newest_count: int, top_since_hours: int, top_count: int):
    d_new = gql(NEWEST_QUERY, {"minutes": newest_minutes, "limit": newest_count})
    newest_rows = d_new.get("Solana", {}).get("TokenSupplyUpdates", []) or []
    newest = []
    for r in newest_rows:
        c = (r.get("TokenSupplyUpdate") or {}).get("Currency") or {}
        mint = c.get("MintAddress")
        if mint:
            newest.append({
                "mint": mint,
                "name": c.get("Name") or "",
                "symbol": c.get("Symbol") or "",
                "uri": norm_ipfs(c.get("Uri") or ""),
            })
    print(f"Newest mints (last {newest_minutes}m): {len(newest)}")

    d_top = gql(TOP_5M_QUERY_HOURS, {"hours": top_since_hours, "limit": top_count})
    top_rows = d_top.get("Solana", {}).get("DEXTradeByTokens", []) or []
    top = []
    for r in top_rows:
        t  = r.get("Trade", {}) or {}
        c  = t.get("Currency", {}) or {}
        ch = r.get("Marketcap_Change_5min")
        top.append({
            "mint": c.get("MintAddress"),
            "name": c.get("Name") or "",
            "symbol": c.get("Symbol") or "",
            "change5m": float(ch) if ch is not None else None
        })
    print(f"Top by 5m MC% (within {top_since_hours}h): {len(top)}")

    if not newest or not top:
        raise SystemExit("No data from Bitquery (newest or top empty).")

    newest_by_mint = {n["mint"]: n for n in newest if n.get("mint")}
    best = None
    for t in top:
        m = t.get("mint")
        if not m: continue
        new = newest_by_mint.get(m)
        if not new: continue
        if not new.get("uri"):
            continue
        if best is None or (t.get("change5m") or -1e9) > (best.get("change5m") or -1e9):
            best = {
                "mint": m,
                "name": new.get("name") or t.get("name") or "Auto Token",
                "symbol": (new.get("symbol") or t.get("symbol") or "AUTO")[:10],
                "uri": new.get("uri"),
                "change5m": t.get("change5m"),
            }

    if best is None:
        for n in newest:
            if n.get("uri"):
                best = {
                    "mint": n["mint"],
                    "name": (n.get("name") or "Auto Token")[:32],
                    "symbol": (n.get("symbol") or "AUTO")[:10],
                    "uri": n["uri"],
                    "change5m": None
                }
                break

    if not best:
        raise SystemExit("No intersecting newest/top candidate with a metadata URI.")

    return best

def main():
    ap = argparse.ArgumentParser(description="Pick newest Pump.fun token with biggest 5m MC% change that has a URI (Bitquery v2/EAP).")
    ap.add_argument("--newest-minutes", type=int, default=int(os.getenv("BQ_NEWEST_MINUTES", "10")))
    ap.add_argument("--newest-count",   type=int, default=int(os.getenv("BQ_NEWEST_COUNT", "30")))
    ap.add_argument("--top-since-hours",type=int, default=int(os.getenv("BQ_TOP_HOURS", "6")))
    ap.add_argument("--top-count",      type=int, default=int(os.getenv("BQ_TOP_COUNT", "50")))
    ap.add_argument("--emit-env", choices=["none","powershell","bash"], default=os.getenv("EMIT_ENV","none"))
    args = ap.parse_args()

    cand = pick_candidate(args.newest_minutes, args.newest_count, args.top_since_hours, args.top_count)

    print("\n=== Picked Candidate ===")
    print(json.dumps(cand, indent=2, ensure_ascii=False))

    if args.emit_env == "powershell":
        print(f'\n# Paste into PowerShell:')
        print(f'$env:LAUNCH_NAME = "{cand["name"]}"')
        print(f'$env:LAUNCH_SYMBOL = "{cand["symbol"]}"')
        print(f'$env:LAUNCH_METADATA_URL = "{cand["uri"]}"')
    elif args.emit_env == "bash":
        print(f'\n# Paste into bash/zsh:')
        print(f'export LAUNCH_NAME="{cand["name"]}"')
        print(f'export LAUNCH_SYMBOL="{cand["symbol"]}"')
        print(f'export LAUNCH_METADATA_URL="{cand["uri"]}"')

if __name__ == "__main__":
    main()
