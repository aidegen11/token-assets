// src/portal-local.ts
import { VersionedTransaction, Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import * as path from "path";

// Convert Buffer -> plain ArrayBuffer (avoid SharedArrayBuffer type issues)
function bufToAB(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}
function guessMimeFromPath(p: string) {
  const s = p.toLowerCase();
  if (s.endsWith(".png")) return "image/png";
  if (s.endsWith(".jpg") || s.endsWith(".jpeg")) return "image/jpeg";
  if (s.endsWith(".gif")) return "image/gif";
  if (s.endsWith(".webp")) return "image/webp";
  if (s.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

export async function sendLocalCreateTx(opts: {
  rpcUrl: string;
  signerPrivateKey: string;          // base58 or base64
  name: string;
  symbol: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  showName?: boolean;
  // provide exactly one of:
  imagePath?: string;                // local file
  imageUrl?: string;                 // http(s)
  // trade params
  devBuySol: number;                 // must be > 0
  slippage: number;                  // %
  priorityFee?: number;              // SOL (set 0 to avoid tip)
  pool?: "pump";
}) {
  const {
    rpcUrl,
    signerPrivateKey,
    name: rawName,
    symbol: rawSymbol,
    description = "",
    twitter = "",
    telegram = "",
    website = "",
    showName = true,
    imagePath,
    imageUrl,
    devBuySol,
    slippage,
    priorityFee = 0,
    pool = "pump",
  } = opts;

  if (!(devBuySol > 0)) throw new Error("devBuySol must be > 0");
  if (!imagePath && !imageUrl) throw new Error("Provide imagePath or imageUrl");

  // Decode signer key (base58 or base64)
  let signer: Keypair;
  try {
    // base64
    signer = Keypair.fromSecretKey(Buffer.from(signerPrivateKey, "base64"));
  } catch {
    // base58
    signer = Keypair.fromSecretKey(bs58.decode(signerPrivateKey));
  }

  let name = rawName.slice(0, 32);
  let symbol = rawSymbol.slice(0, 10);

  // 1) Upload metadata via pump.fun /api/ipfs
  const form = new FormData();
  form.append("name", name);
  form.append("symbol", symbol);
  form.append("description", description);
  if (twitter)  form.append("twitter", twitter);
  if (telegram) form.append("telegram", telegram);
  if (website)  form.append("website", website);
  form.append("showName", showName ? "true" : "false");

  if (imagePath) {
    const bytes = await (await import("fs/promises")).readFile(imagePath);
    const blob = new Blob([bufToAB(bytes)], { type: guessMimeFromPath(imagePath) });
    form.append("file", blob, path.basename(imagePath));
  } else {
    const r = await fetch(imageUrl!);
    if (!r.ok) throw new Error(`Failed to fetch LAUNCH_IMAGE_URL (${r.status})`);
    const ab = await r.arrayBuffer();
    const url = new URL(imageUrl!);
    const ct = r.headers.get("content-type") || guessMimeFromPath(url.pathname);
    const fname = path.basename(url.pathname) || "image";
    form.append("file", new Blob([ab], { type: ct }), fname);
  }

  const ipfsRes = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: form });
  const ipfsTxt = await ipfsRes.text();
  let ipfsJson: any;
  try { ipfsJson = JSON.parse(ipfsTxt); } catch { throw new Error(`pump.fun /api/ipfs bad JSON: ${ipfsTxt}`); }
  if (!ipfsRes.ok) throw new Error(`pump.fun /api/ipfs ${ipfsRes.status}: ${ipfsTxt}`);

  const metadataUri = ipfsJson?.metadataUri as string | undefined;
  if (!metadataUri) throw new Error("pump.fun /api/ipfs returned no metadataUri");

  // 2) Ask PumpPortal for a LOCAL (unsigned) create tx
  const mintKeypair = Keypair.generate();

  const localReq = {
    publicKey: signer.publicKey.toBase58(),
    action: "create",
    tokenMetadata: {
      name: ipfsJson?.metadata?.name ?? name,
      symbol: ipfsJson?.metadata?.symbol ?? symbol,
      uri: metadataUri,
    },
    mint: mintKeypair.publicKey.toBase58(),
    denominatedInSol: "true",
    amount: devBuySol,
    slippage,
    priorityFee,              // set 0 to avoid tip
    pool,
  };

  console.log("PumpPortal LOCAL request preview:", {
    ...localReq, tokenMetadata: { ...localReq.tokenMetadata }, // shallow preview
  });

  const localRes = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(localReq),
  });

  if (!localRes.ok) throw new Error(`trade-local ${localRes.status}: ${await localRes.text()}`);

  // The LOCAL API returns a serialized v0 tx as raw bytes
  const buf = new Uint8Array(await localRes.arrayBuffer());
  const tx = VersionedTransaction.deserialize(buf);

  // Sign with mint + your wallet, then send yourself (no bundled Jito tip)
  tx.sign([mintKeypair, signer]);

  const conn = new Connection(rpcUrl, "confirmed");
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, preflightCommitment: "confirmed" });
  return { signature: sig, mint: mintKeypair.publicKey.toBase58() };
}
