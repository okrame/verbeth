// packages/sdk/src/addresses.ts

export interface ChainConfig {
  verbethProxy: `0x${string}`;
  verbethImpl: `0x${string}`;
  creationBlock: number;
  moduleSetupHelper?: `0x${string}`;
}

export const VERBETH_CONFIG: ChainConfig = {
  verbethProxy: '0x82C9c5475D63e4C9e959280e9066aBb24973a663',
  verbethImpl: '0x51670aB6eDE1d1B11C654CCA53b7D42080802326',
  creationBlock: 37_097_547, // *** only base sepolia for now
} as const;

export const MODULE_SETUP_HELPERS: Record<number, `0x${string}`> = {
  8453: '0xc022F74924BDB4b62D830234d89b066359bF67c0',  
  84532: '0xbd59Fea46D308eDF3b75C22a6f64AC68feFc731A',  
} as const;

export function getVerbethAddress(): `0x${string}` {
  return VERBETH_CONFIG.verbethProxy;
}

export function getCreationBlock(): number {
  return VERBETH_CONFIG.creationBlock;
}

export function getModuleSetupHelper(chainId: number): `0x${string}` | undefined {
  return MODULE_SETUP_HELPERS[chainId];
}

export function isModuleSetupSupported(chainId: number): boolean {
  return chainId in MODULE_SETUP_HELPERS;
}