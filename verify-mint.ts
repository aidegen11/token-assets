// verify-mint.ts
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const MINT = process.env.MINT || process.argv[2];

if (!MINT) {
  console.error("Usage: tsx verify-mint.ts <MINT_ADDRESS>");
  process.exit(1);
}

const MPL_TOKEN_METADATA = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

function findMetadataPda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), MPL_TOKEN_METADATA.toBuffer(), mint.toBuffer()],
    MPL_TOKEN_METADATA
  )[0];
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const mintPk = new PublicKey(MINT);

  const mintInfo = await conn.getAccountInfo(mintPk);
  console.log("Mint account exists:", !!mintInfo, mintInfo ? `lamports=${mintInfo.lamports}` : "");

  const metaPda = findMetadataPda(mintPk);
  const metaInfo = await conn.getAccountInfo(metaPda);
  console.log("Metadata PDA exists:", !!metaInfo, metaInfo ? `lamports=${metaInfo.lamports}` : "");

  // Try to find a recent signature touching the mint address (creator tx or dev-buy swap)
  const sigs = await conn.getSignaturesForAddress(mintPk, { limit: 5 });
  console.log("Recent signatures for mint:");
  for (const s of sigs) {
    console.log(` - ${s.signature}  (slot=${s.slot})`);
  }
}

main().catch((e) => {
  console.error("verify error:", e);
  process.exit(1);
});
