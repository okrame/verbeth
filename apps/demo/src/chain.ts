import { base, baseSepolia, type Chain } from "viem/chains";

export const DEFAULT_CHAIN_ID = 84532;

const CHAIN_BY_ID: Record<number, Chain> = {
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
};

const PUBLIC_HTTP_URLS_BY_CHAIN: Record<number, readonly string[]> = {
  [base.id]: [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
  ],
  [baseSepolia.id]: [
    "https://sepolia.base.org",
    "https://base-sepolia-rpc.publicnode.com",
  ],
};

function readChainIdFromEnv(): number {
  const fromEnv = Number(import.meta.env.VITE_CHAIN_ID);
  if (Number.isInteger(fromEnv) && CHAIN_BY_ID[fromEnv]) {
    return fromEnv;
  }
  if (Number.isInteger(fromEnv)) {
    console.warn(
      `[verbeth] unsupported VITE_CHAIN_ID=${fromEnv}, falling back to ${DEFAULT_CHAIN_ID}`
    );
  }
  return DEFAULT_CHAIN_ID;
}

export const APP_CHAIN_ID = readChainIdFromEnv();
export const APP_CHAIN = CHAIN_BY_ID[APP_CHAIN_ID];

export function getPublicHttpUrlsForChain(chainId: number): readonly string[] {
  return PUBLIC_HTTP_URLS_BY_CHAIN[chainId] ?? PUBLIC_HTTP_URLS_BY_CHAIN[DEFAULT_CHAIN_ID];
}

// Optional private RPC URLs from env vars (Alchemy, Infura, etc.)
const ALCHEMY_HTTP_URL = import.meta.env.VITE_RPC_HTTP_URL as string | undefined;
export const APP_WS_URL = import.meta.env.VITE_RPC_WS_URL as string | undefined;

/** Returns [alchemy (if set), ...public] — Alchemy has priority. */
export function getHttpUrlsForChain(chainId: number): readonly string[] {
  const publicUrls = getPublicHttpUrlsForChain(chainId);
  if (ALCHEMY_HTTP_URL) return [ALCHEMY_HTTP_URL, ...publicUrls];
  return publicUrls;
}

