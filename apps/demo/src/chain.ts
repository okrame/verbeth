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

// Optional private RPC URLs from env vars (Alchemy, Infura, etc.)
const ALCHEMY_HTTP_URL = import.meta.env.VITE_RPC_HTTP_URL as string | undefined;
const ALCHEMY_WS_URL = import.meta.env.VITE_RPC_WS_URL as string | undefined;

// Alchemy subdomain per chain
const ALCHEMY_WS_SUBDOMAIN: Record<number, string> = {
  [base.id]: "base-mainnet",
  [baseSepolia.id]: "base-sepolia",
  [sepolia.id]: "eth-sepolia",
};

const ALCHEMY_HTTP_SUBDOMAIN: Record<number, string> = {
  [base.id]: "base-mainnet",
  [baseSepolia.id]: "base-sepolia",
  [sepolia.id]: "eth-sepolia",
};

/**
 * Rewrite an Alchemy URL's subdomain for the target chain.
 * Returns { url, rewritten } where rewritten=true if the subdomain was changed.
 * Returns undefined if the input is not an Alchemy URL.
 */
function rewriteAlchemyUrl(
  url: string | undefined,
  chainId: number,
  subdomainMap: Record<number, string>,
): { url: string; rewritten: boolean } | undefined {
  if (!url) return undefined;
  const subdomain = subdomainMap[chainId];
  if (!subdomain) return undefined;
  const result = url.replace(/\/\/[^./]+\.g\.alchemy\.com/, `//${subdomain}.g.alchemy.com`);
  if (result === url) return { url, rewritten: false }; // already correct chain or not Alchemy
  return { url: result, rewritten: true };
}

/** Returns the WS URL for the given chain, rewriting Alchemy subdomain as needed. */
export function getWsUrlForChain(chainId: number): string | undefined {
  const result = rewriteAlchemyUrl(ALCHEMY_WS_URL, chainId, ALCHEMY_WS_SUBDOMAIN);
  return result?.url ?? ALCHEMY_WS_URL;
}

export function getChainById(chainId: number): Chain | undefined {
  return CHAIN_BY_ID[chainId];
}

/**
 * Returns HTTP URLs for the given chain.
 * - Original Alchemy chain: [alchemy, ...public] (Alchemy first)
 * - Rewritten Alchemy chain: [...public, alchemy] (public first — Alchemy may not support it)
 * - No Alchemy configured:  [...public]
 */
export function getHttpUrlsForChain(chainId: number): readonly string[] {
  const publicUrls = getPublicHttpUrlsForChain(chainId);
  const alchemy = rewriteAlchemyUrl(ALCHEMY_HTTP_URL, chainId, ALCHEMY_HTTP_SUBDOMAIN);
  if (!alchemy) {
    // Not an Alchemy URL — use raw env var if set, else just public
    if (ALCHEMY_HTTP_URL) return [ALCHEMY_HTTP_URL, ...publicUrls];
    return publicUrls;
  }
  if (alchemy.rewritten) {
    // Different chain than configured — public RPCs first, Alchemy as fallback
    return [...publicUrls, alchemy.url];
  }
  // Same chain as configured — Alchemy first
  return [alchemy.url, ...publicUrls];
}

