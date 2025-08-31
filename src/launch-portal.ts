// src/launch-portal.ts
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export type LaunchPortalParams = {
  name: string;
  symbol: string;
  uri: string;         // ipfs://... or https gateway
  devBuySol: number;   // must be > 0 for “free” create to work (they take fees from this)
  slippage: number;    // %
  priorityFee: number; // SOL
  pool?: "pump";       // default "pump"
  denominatedInSol?: boolean; // default true
};

export type LaunchPortalResult = {
  signature?: string;
  mint: string;        // mint public key
  raw?: unknown;       // raw JSON from portal
};

export async function launchViaPumpPortal(params: LaunchPortalParams): Promise<LaunchPortalResult> {
  const apiKey = process.env.PUMPPORTAL_API_KEY || "";
  if (!apiKey) throw new Error("Missing PUMPPORTAL_API_KEY");

  // Endpoint from docs (you can override with PUMPPORTAL_ENDPOINT if needed)
  const base = process.env.PUMPPORTAL_ENDPOINT || "https://pumpportal.fun";
  const endpoint = `${base.replace(/\/+$/, "")}/api/trade?api-key=${encodeURIComponent(apiKey)}`;

  // Portal expects a *mint keypair* so it can sign the create. Provide base58 secret.
  const mintKeypair = Keypair.generate();
  const mintSecretBase58 = bs58.encode(mintKeypair.secretKey);
  const mintPub = mintKeypair.publicKey.toBase58();

  const body = {
    action: "create",
    tokenMetadata: {
      name: params.name,
      symbol: params.symbol,
      uri: params.uri,
    },
    mint: mintSecretBase58,
    denominatedInSol: String(params.denominatedInSol ?? true), // docs show strings "true"/"false"
    amount: params.devBuySol,         // dev buy in SOL (number)
    slippage: params.slippage,        // %
    priorityFee: params.priorityFee,  // SOL
    pool: params.pool ?? "pump",
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* keep text fallback */ }

  if (!res.ok) {
    throw new Error(`Portal HTTP ${res.status}: ${text.slice(0, 1000)}`);
  }

  const signature = json?.signature || json?.tx || json?.transactionSignature || undefined;
  // Some portals don’t echo back the mint; we already know it.
  return { signature, mint: mintPub, raw: json ?? text };
}
