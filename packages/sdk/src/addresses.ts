// packages/sdk/src/addresses.ts

// deterministic CREATE2 deployments
export const VERBETH_ADDRESSES = {
  verbethProxy: '0x82C9c5475D63e4C9e959280e9066aBb24973a663' as `0x${string}`,
  verbethImpl: '0x51670aB6eDE1d1B11C654CCA53b7D42080802326' as `0x${string}`,
} as const;
export const MODULE_SETUP_HELPER = '0xbd59Fea46D308eDF3b75C22a6f64AC68feFc731A' as `0x${string}`;
export const SESSION_MODULE = '0xFDBcE316F66e20Cae78D969b4f6635C703C53805' as `0x${string}`;

// block at which verbeth was deployed
export const CREATION_BLOCKS: Record<number, number> = {
  8453: 42_658_728,      
  84532: 37_097_547,     
  11155111: 10_340_254,  
} as const;

export function getVerbethAddress(): `0x${string}` {
  return VERBETH_ADDRESSES.verbethProxy;
}

export function getCreationBlock(chainId: number): number {
  const block = CREATION_BLOCKS[chainId];
  if (block === undefined) throw new Error(`Unsupported chain: ${chainId}`);
  return block;
}

export function getModuleSetupHelper(chainId: number): `0x${string}` | undefined {
  return chainId in CREATION_BLOCKS ? MODULE_SETUP_HELPER : undefined;
}

export function isModuleSetupSupported(chainId: number): boolean {
  return chainId in CREATION_BLOCKS;
}