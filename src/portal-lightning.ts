// src/portal-lightning.ts
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import * as fs from "fs/promises";
import * as path from "path";

function guessMimeFromPath(p: string) {
  const s = p.toLowerCase();
  if (s.endsWith(".png")) return "image/png";
  if (s.endsWith(".jpg") || s.endsWith(".jpeg")) return "image/jpeg";
  if (s.endsWith(".gif")) return "image/gif";
  if (s.endsWith(".webp")) return "image/webp";
  if (s.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

// Copy Buffer into a fresh ArrayBuffer (avoid SharedArrayBuffer typing)
function bufferToPlainArrayBuffer(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

// Small helper for labeled fetch with timeout and better errors
async function fetchOrThrow(url: string, init: RequestInit & { label?: string, timeoutMs?: number } = {}) {
  const { label, timeoutMs = 20000, ...rest } = init;
  try {
    const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    return res;
  } catch (e: any) {
    const where = label ? `${label} (${url})` : url;
    throw new Error(`Network error while fetching ${where}: ${e?.message || e}`);
  }
}

export async function sendCreateTx(opts: {
  apiKey: string;

  // Provide ONE of these
  imagePath?: string;    // local file path (recommended: most reliable)
  imageUrl?: string;     // http(s) URL

  name: string;
  symbol: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  showName?: boolean;
  devBuySol: number;   // must be > 0
  slippage: number;    // %
  priorityFee: number; // SOL
  pool?: "pump";
}) {
  const {
    apiKey,
    imagePath,
    imageUrl,
    name: rawName,
    symbol: rawSymbol,
    description = "",
    twitter = "",
    telegram = "",
    website = "",
    showName = true,
    devBuySol,
    slippage,
    priorityFee,
    pool = "pump",
  } = opts;

  if (!apiKey) throw new Error("Missing PumpPortal API key");
  if (!(devBuySol > 0)) throw new Error("devBuySol must be > 0");
  if (!imagePath && !imageUrl) throw new Error("Provide imagePath or imageUrl");

  let name = (rawName || "Auto Token").slice(0, 32);
  let symbol = (rawSymbol || "AUTO").slice(0, 10);

  // 1) Build metadata via pump.fun /api/ipfs
  const form = new FormData();
  form.append("name", name);
  form.append("symbol", symbol);
  form.append("description", description);
  if (twitter)  form.append("twitter", twitter);
  if (telegram) form.append("telegram", telegram);
  if (website)  form.append("website", website);
  form.append("showName", showName ? "true" : "false");

  if (imagePath) {
    // Local file path (most reliable)
    const bytes = await fs.readFile(imagePath).catch((e) => {
      throw new Error(`Failed to read imagePath "${imagePath}": ${e?.message || e}`);
    });
    const blob = new Blob([bufferToPlainArrayBuffer(bytes)], { type: guessMimeFromPath(imagePath) });
    form.append("file", blob, path.basename(imagePath));
    console.log("Using local image:", imagePath);
  } else if (imageUrl) {
    // Remote image URL
    console.log("Fetching remote image:", imageUrl);
    const r = await fetchOrThrow(imageUrl, { label: "image URL", timeoutMs: 20000 });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`Image fetch failed (${r.status}) from ${imageUrl}: ${body.slice(0, 200)}`);
    }
    const ab = await r.arrayBuffer();
    const url = new URL(imageUrl);
    const ct = r.headers.get("content-type") || guessMimeFromPath(url.pathname);
    const fname = path.basename(url.pathname) || "image";
    const blob = new Blob([ab], { type: ct });
    form.append("file", blob, fname);
  }

  // POST to pump.fun /api/ipfs
  const ipfsRes = await fetchOrThrow("https://pump.fun/api/ipfs", {
    method: "POST",
    body: form,
    label: "pump.fun /api/ipfs",
    timeoutMs: 25000,
  });
  const txt = await ipfsRes.text();
  let j: any; try { j = JSON.parse(txt); } catch { throw new Error(`pump.fun /api/ipfs bad JSON: ${txt}`); }
  if (!ipfsRes.ok) throw new Error(`pump.fun /api/ipfs ${ipfsRes.status}: ${txt}`);

  const metadataUri = j?.metadataUri as string | undefined;
  if (!metadataUri) throw new Error("pump.fun /api/ipfs returned no metadataUri");

  // Use sanitized values if backend echoed them
  name = (j?.metadata?.name ?? name).slice(0, 32);
  symbol = (j?.metadata?.symbol ?? symbol).slice(0, 10);

  // 2) Ask PumpPortal Lightning to create + dev buy
  const mintKeypair = Keypair.generate();

  console.log("PumpPortal request preview:", {
    name,
    symbol,
    uri: metadataUri,
    amount: devBuySol,
    slippage,
    priorityFee,
    pool,
    denominatedInSol: "true",
    mintPub: mintKeypair.publicKey.toBase58(),
  });

  const body = {
    action: "create",
    tokenMetadata: { name, symbol, uri: metadataUri },
    mint: bs58.encode(mintKeypair.secretKey),
    denominatedInSol: "true",
    amount: devBuySol,
    slippage,
    priorityFee,
    pool,
  };

  const res = await fetchOrThrow(
    `https://pumpportal.fun/api/trade?api-key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      label: "pumpportal.fun /api/trade",
      timeoutMs: 25000,
    }
  );

  const respTxt = await res.text();
  let json: any; try { json = JSON.parse(respTxt); } catch { json = { raw: respTxt }; }
  if (!res.ok) throw new Error(`PumpPortal /api/trade ${res.status}: ${respTxt}`);

  return {
    signature: json?.signature || json?.tx || json?.transactionSignature,
    mint: json?.mint || mintKeypair.publicKey.toBase58(),
    raw: json,
  };
}
