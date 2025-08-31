// example-trending.ts
import "dotenv/config";
import { buildConfigFromSTTrending } from "./src/auto-config-st";
import { fetchMetaplexJson } from "./src/bitquery";
import { sendLocalCreateTx } from "./src/portal-local";     // ← local (cheaper)
import { sendCreateTx } from "./src/portal-lightning";      // ← lightning fallback

function ipfsToGateway(uri: string, gw = "https://ipfs.io/ipfs/") {
  if (!uri) return uri;
  if (uri.startsWith("ipfs://")) return gw + uri.replace(/^ipfs:\/\//, "").replace(/^ipfs\//, "");
  return uri;
}

async function main() {
  const USE_LOCAL = (process.env.USE_TRADE_LOCAL || "true").toLowerCase() === "true"; // default LOCAL
  const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

  const defaults = {
    initialBuy: Number(process.env.DEV_BUY_SOL ?? 0.001),
    slippage: Number(process.env.LAUNCH_SLIPPAGE ?? 5),
    priorityFee: Number(process.env.LAUNCH_PRIORITY_FEE ?? 0), // keep 0 to avoid tip
  };

  // 1) pick a trending token (for its name/symbol & metadata)
  let tokenCfg = await buildConfigFromSTTrending({
    timeframe: "1h",
    limit: Number(process.env.ST_LIMIT || 50),
    defaultInitialBuy: defaults.initialBuy,
    defaultSlippage: defaults.slippage,
    defaultPriorityFee: defaults.priorityFee,
  }).catch(() => null);

  const baseName = (process.env.LAUNCH_NAME || tokenCfg?.name || "Auto Token").slice(0, 32);
  const baseSymbol = (process.env.LAUNCH_SYMBOL || tokenCfg?.symbol || "AUTO").slice(0, 10);

  // 2) resolve metadata + image from the trending token
  const metaUri = tokenCfg?.metadataUrl || process.env.LAUNCH_METADATA_URL || "";

  let imageUrl = process.env.LAUNCH_IMAGE_URL || "";
  if (!imageUrl && metaUri) {
    const meta = await fetchMetaplexJson(metaUri).catch(() => ({} as any));
    imageUrl = ipfsToGateway(meta?.image || meta?.image_url || "");
  }
  if (!imageUrl) {
    throw new Error("No image found. Set LAUNCH_IMAGE_URL or ensure trending metadata has an image.");
  }

  // 3) OPTION 2 — prefer original description from the trending token's metadata
  let descriptionToUse = (process.env.LAUNCH_DESCRIPTION ?? "").toString();
  if (!descriptionToUse && metaUri) {
    const orig = await fetchMetaplexJson(metaUri).catch(() => null);
    descriptionToUse = (orig?.description ?? "").toString();
  }

  const devBuy = Number(process.env.DEV_BUY_SOL ?? "0.001");

  if (USE_LOCAL) {
    // LOCAL path → cheaper (0.5% portal fee), no auto Jito tip
    const signerKey = process.env.PRIVATE_KEY_BASE64_OR_BASE58 || "";
    if (!signerKey) throw new Error("Set PRIVATE_KEY_BASE64_OR_BASE58 for LOCAL route.");

    console.log("Creating via LOCAL API (cheaper, no tip).");
    const { signature, mint } = await sendLocalCreateTx({
      rpcUrl: RPC,
      signerPrivateKey: signerKey,
      name: baseName,
      symbol: baseSymbol,
      imageUrl,
      description: descriptionToUse,             // ← use ST description (or env/empty)
      twitter: process.env.LAUNCH_TWITTER || "",
      telegram: process.env.LAUNCH_TELEGRAM || "",
      website: process.env.LAUNCH_WEBSITE || "",
      showName: true,
      devBuySol: devBuy,
      slippage: defaults.slippage,
      priorityFee: defaults.priorityFee,        // keep 0 to avoid Jito tip
      pool: "pump",
    });

    console.log("🎉 LOCAL create sent");
    console.log("Mint:", mint);
    console.log("Tx:", signature);
    console.log(`https://solscan.io/tx/${signature}`);
  } else {
    // Lightning path (1% fee, may include Jito tip even if you set 0)
    console.log("Creating via LIGHTNING API (1% fee).");
    const { signature, mint } = await sendCreateTx({
      apiKey: process.env.PUMPPORTAL_API_KEY || "",
      imageUrl,
      name: baseName,
      symbol: baseSymbol,
      description: descriptionToUse,             // ← use ST description (or env/empty)
      twitter: process.env.LAUNCH_TWITTER || "",
      telegram: process.env.LAUNCH_TELEGRAM || "",
      website: process.env.LAUNCH_WEBSITE || "",
      showName: true,
      devBuySol: devBuy,
      slippage: defaults.slippage,
      priorityFee: defaults.priorityFee,
      pool: "pump",
    });

    console.log("🎉 LIGHTNING create ok");
    console.log("Mint:", mint);
    console.log("Tx:", signature);
    console.log(`https://solscan.io/tx/${signature}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Fatal:", (e as any)?.message || e);
    process.exitCode = 1;
  });
}
export default main;
