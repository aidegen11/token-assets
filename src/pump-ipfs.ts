// src/pump-ipfs.ts
import FormData from "form-data";

async function getFetch(): Promise<typeof fetch> {
  if (typeof fetch !== "undefined") return fetch as any;
  const mod = await import("node-fetch");
  return (mod as any).default || (mod as any);
}

/** Build metadata via pump.fun IPFS endpoint (same as the website). */
export async function makePumpfunMetadataFromImageUrl(opts: {
  name: string;
  symbol: string;
  imageUrl: string;          // http(s)
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  showName?: boolean;
}): Promise<string> {
  const {
    name, symbol, imageUrl,
    description = "", twitter = "", telegram = "", website = "",
    showName = true,
  } = opts;

  const f = await getFetch();

  const imgRes = await f(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to fetch image (${imgRes.status})`);
  const imgBuf = Buffer.from(await imgRes.arrayBuffer());
  const contentType = imgRes.headers.get("content-type") || "image/png";

  const form = new FormData();
  form.append("name", name);
  form.append("symbol", symbol);
  form.append("description", description);
  if (twitter)  form.append("twitter", twitter);
  if (telegram) form.append("telegram", telegram);
  if (website)  form.append("website", website);
  form.append("showName", String(showName));
  form.append("file", imgBuf, { filename: "image", contentType });

  const res = await f("https://pump.fun/api/ipfs", { method: "POST", body: form as any });
  const txt = await res.text();
  let json: any;
  try { json = JSON.parse(txt); } catch { throw new Error(`pump.fun /api/ipfs bad JSON: ${txt}`); }
  if (!res.ok) throw new Error(`pump.fun /api/ipfs ${res.status}: ${txt}`);

  const uri = json?.metadataUri as string | undefined;
  if (!uri) throw new Error("pump.fun /api/ipfs returned no metadataUri");
  return uri; // ipfs://...
}
