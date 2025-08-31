// src/bitquery-sub.ts
import WebSocket from "ws";

export type NewPumpfunToken = {
  name?: string;
  symbol?: string;
  mintAddress?: string;
  uri?: string;
  updateAuthority?: string;
  decimals?: number;
  txSigner?: string;
  blockTime?: string; // ISO
};

const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// Bitquery requires the token in the URL for websockets.
// Docs: wss://streaming.bitquery.io/graphql?token=ory_at_...  (Bearer-in-URL)
// and subprotocol header: Sec-WebSocket-Protocol: graphql-ws
// Ref: docs.bitquery.io authorisation + websockets pages. :contentReference[oaicite:1]{index=1}
function buildUrlWithToken(token: string) {
  const base = "wss://streaming.bitquery.io/graphql";
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}token=${encodeURIComponent(token)}`;
}

const SUBSCRIPTION = /* GraphQL */ `
  subscription {
    Solana {
      TokenSupplyUpdates(
        where: {
          Instruction: {
            Program: { Address: { is: "${PUMP_FUN_PROGRAM}" }, Method: { is: "create" } }
          }
        }
      ) {
        Block { Time { iso8601 } }
        Transaction { Signer }
        TokenSupplyUpdate {
          Amount
          PostBalance
          Currency {
            Name
            Symbol
            MintAddress
            Uri
            UpdateAuthority
            Decimals
            ProgramAddress
            MetadataAddress
            TokenStandard
          }
        }
      }
    }
  }
`;

export function subscribeNewPumpfunCreations(
  onEvent: (t: NewPumpfunToken) => void,
  onError?: (err: any) => void
) {
  const token = process.env.BITQUERY_API_KEY || "";
  if (!token) throw new Error("Missing BITQUERY_API_KEY");
  const url = buildUrlWithToken(token);

  const ws = new WebSocket(url, "graphql-ws", {
    headers: { "Content-Type": "application/json" }, // Bitquery notes this header, subprotocol set above
  });

  let started = false;
  const SUB_ID = "1";

  ws.on("open", () => {
    // Apollo 'graphql-ws' legacy protocol
    ws.send(JSON.stringify({ type: "connection_init", payload: {} }));
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case "connection_ack":
          if (!started) {
            started = true;
            ws.send(JSON.stringify({ id: SUB_ID, type: "start", payload: { query: SUBSCRIPTION } }));
          }
          break;
        case "ka": // keep-alive
          break;
        case "data": {
          const node =
            msg?.payload?.data?.Solana?.TokenSupplyUpdates?.[0];
          if (!node) break;

          const cur = node.TokenSupplyUpdate?.Currency ?? {};
          const t: NewPumpfunToken = {
            name: cur.Name,
            symbol: cur.Symbol,
            mintAddress: cur.MintAddress,
            uri: cur.Uri,
            updateAuthority: cur.UpdateAuthority,
            decimals: cur.Decimals,
            txSigner: node.Transaction?.Signer,
            blockTime: node.Block?.Time?.iso8601,
          };
          onEvent(t);
          break;
        }
        case "error":
        case "connection_error":
          onError?.(msg);
          break;
        case "complete":
          break;
      }
    } catch (e) {
      onError?.(e);
    }
  });

  ws.on("error", (e) => onError?.(e));
  ws.on("close", () => {
    // optional: reconnect/backoff here
  });

  return () => ws.close();
}
