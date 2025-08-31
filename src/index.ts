// src/index.ts

// Types used around your auto-config + portal flow
export interface TokenLaunchConfig {
  name: string;
  symbol: string;
  metadataUrl: string;   // ipfs://... or https gateway
  initialBuy?: number;   // kept for compatibility (not used by Lightning create)
  slippage?: number;
  priorityFee?: number;
}

// (Kept for compatibility if other code imports it; not used by Lightning create)
export interface LaunchResult {
  success: boolean;
  signature?: string;
  tokenAddress?: string;
  error?: string;
}

// Public API surface for the Lightning-only setup
export { buildConfigFromSTTrending } from "./auto-config-st";
export { sendCreateTx } from "./portal-lightning";
