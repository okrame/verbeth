import { base, baseSepolia, sepolia, type Chain } from "viem/chains";

export const DEFAULT_CHAIN_ID = 84532;

export const SUPPORTED_CHAIN_IDS = new Set([8453, 84532, 11155111]);

export function isSupportedChain(chainId: number): boolean {
  return SUPPORTED_CHAIN_IDS.has(chainId);
}

const CHAIN_BY_ID: Record<number, Chain> = {
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
  [sepolia.id]: sepolia,
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
  [sepolia.id]: [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://rpc.sepolia.org",
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

// Optional Alchemy API key — used only for WebSocket block watching
const ALCHEMY_KEY = import.meta.env.VITE_ALCHEMY_KEY as string | undefined;

const ALCHEMY_WS_SUBDOMAIN: Record<number, string> = {
  [base.id]: "base-mainnet",
  [baseSepolia.id]: "base-sepolia",
  [sepolia.id]: "eth-sepolia",
};

/** Returns the Alchemy WS URL for the given chain, constructed from VITE_ALCHEMY_KEY. */
export function getWsUrlForChain(chainId: number): string | undefined {
  if (!ALCHEMY_KEY) return undefined;
  const subdomain = ALCHEMY_WS_SUBDOMAIN[chainId];
  if (!subdomain) return undefined;
  return `wss://${subdomain}.g.alchemy.com/v2/${ALCHEMY_KEY}`;
}

export function getChainById(chainId: number): Chain | undefined {
  return CHAIN_BY_ID[chainId];
}

/** Returns HTTP URLs for the given chain (public RPCs only). */
export function getHttpUrlsForChain(chainId: number): readonly string[] {
  return getPublicHttpUrlsForChain(chainId);
}

