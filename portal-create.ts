// portal-create.ts
import { sendCreateTx } from "./src/portal-lightning";
import "dotenv/config";

async function run() {
  const res = await sendCreateTx({
    apiKey: process.env.PUMPPORTAL_API_KEY || "",
    // choose ONE of these based on your use case:
    imageUrl: process.env.PORTAL_IMAGE_URL,            // hosted image (preferred)
    imagePath: process.env.PORTAL_IMAGE_PATH || "",    // or local file

    name: process.env.PORTAL_NAME || process.env.LAUNCH_NAME || "PPTest",
    symbol: process.env.PORTAL_SYMBOL || process.env.LAUNCH_SYMBOL || "TEST",
    description: process.env.PORTAL_DESCRIPTION || "Created via PumpPortal.fun",
    twitter: process.env.PORTAL_TWITTER || "",
    telegram: process.env.PORTAL_TELEGRAM || "",
    website: process.env.PORTAL_WEBSITE || "https://pumpportal.fun",
    showName: true,

    devBuySol: Number(process.env.DEV_BUY_SOL ?? "0.001"),
    slippage: Number(process.env.LAUNCH_SLIPPAGE ?? "5"),
    priorityFee: Number(process.env.LAUNCH_PRIORITY_FEE ?? "0"), // <- keep at 0 to avoid extra
    pool: "pump",
  });

  console.log("🎉 Portal create response");
  console.log("Mint:", res.mint);
  console.log("Tx:", res.signature);
  console.dir(res, { depth: null });
}

run().catch((e) => {
  console.error("Fatal:", e?.message || e);
  process.exitCode = 1;
});
