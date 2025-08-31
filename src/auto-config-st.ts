// src/auto-config-st.ts
import type { TokenLaunchConfig } from "./index";
import { stGetTrending, stGetTokenByMint, type STTimeframe } from "./solanatracker";
import { fetchMetaplexJson } from "./bitquery";
import { makePumpfunMetadataFromImageUrl } from "./pump-ipfs";

// Map gateway → ipfs:// while PRESERVING any trailing path; leave ipfs:// untouched
function shortenToIpfsScheme(u?: string | null): string | undefined {
  if (!u) return undefined;
  if (u.startsWith("ipfs://")) return u; // keep as-is (don’t strip path/query)
  const m = u.match(/\/ipfs\/([A-Za-z0-9]+)(\/[^?#]*)?(?:[?#].*)?$/);
  if (m) return `ipfs://${m[1]}${m[2] || ""}`;
  return u;
}

export async function buildConfigFromSTTrending(params?: {
  timeframe?: STTimeframe;   // default 1h
  limit?: number;
  defaultInitialBuy?: number;
  defaultSlippage?: number;
  defaultPriorityFee?: number;
}): Promise<TokenLaunchConfig> {
  const {
    timeframe = "1h",
    limit = 10,
    defaultInitialBuy = 0.001,
    defaultSlippage = 5,
    defaultPriorityFee = 0,
  } = params || {};

  const trending = await stGetTrending(timeframe, limit);

  // Shuffle so we don't always pick the first
  for (let i = trending.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [trending[i], trending[j]] = [trending[j], trending[i]];
  }
  console.log(`Trending candidates (${timeframe}):`, trending.length);

  let pickedWithUri:
    | { name: string; symbol: string; mintAddress: string; uri: string; image?: string }
    | undefined;
  let pickedWithImage:
    | { name: string; symbol: string; mintAddress: string; image: string }
    | undefined;

  for (const row of trending) {
    if (!pickedWithImage && row?.image) {
      pickedWithImage = {
        name: (row.name || "Auto Token").slice(0, 32),
        symbol: (row.symbol || "AUTO").slice(0, 10),
        mintAddress: row.mintAddress,
        image: row.image,
      };
    }
    if (row?.uri) {
      pickedWithUri = {
        name: (row.name || "Auto Token").slice(0, 32),
        symbol: (row.symbol || "AUTO").slice(0, 10),
        mintAddress: row.mintAddress,
        uri: row.uri,
        image: row.image,
      };
      break;
    }
    if (!row?.uri && row?.mintAddress) {
      const full = await stGetTokenByMint(row.mintAddress).catch(() => null);
      if (full?.uri) {
        pickedWithUri = {
          name: (row.name || full.name || "Auto Token").slice(0, 32),
          symbol: (row.symbol || full.symbol || "AUTO").slice(0, 10),
          mintAddress: row.mintAddress,
          uri: full.uri,
          image: row.image || full.image,
        };
        break;
      }
    }
  }

  // A) Use trending URI (normalized) if present
  if (pickedWithUri) {
    const normalized = shortenToIpfsScheme(pickedWithUri.uri) || pickedWithUri.uri;
    console.log("✅ Using trending metadata URI (normalized):", normalized);
    await fetchMetaplexJson(normalized).catch(() => ({} as any)); // sanity check only
    return {
      name: pickedWithUri.name,
      symbol: pickedWithUri.symbol,
      metadataUrl: normalized,
      initialBuy: defaultInitialBuy,
      slippage: defaultSlippage,
      priorityFee: defaultPriorityFee,
    };
  }

  // B) No URI but we have an image → build minimal metadata via pump.fun /api/ipfs
  if (pickedWithImage?.image) {
    console.log("No trending URI; building metadata via pump.fun /api/ipfs from the trending image.");
    const metadataUrl = await makePumpfunMetadataFromImageUrl({
      name: pickedWithImage.name,
      symbol: pickedWithImage.symbol,
      imageUrl: pickedWithImage.image, // keep their image URL
      description: "",
      showName: true,
    });
    console.log("Built metadata JSON:", metadataUrl);
    return {
      name: pickedWithImage.name,
      symbol: pickedWithImage.symbol,
      metadataUrl,
      initialBuy: defaultInitialBuy,
      slippage: defaultSlippage,
      priorityFee: defaultPriorityFee,
    };
  }

  throw new Error("Fatal: No trending URI and no trending image to build from.");
}
