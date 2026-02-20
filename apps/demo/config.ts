import { http, createConfig } from 'wagmi';
import { base, mainnet, baseSepolia } from 'wagmi/chains';
import { injected, walletConnect } from 'wagmi/connectors';

const projectId = 'abcd4fa063dd349643afb0bdc85bb248';

export const config = createConfig({
  connectors: [
    injected(),
    // wagmi marked walletConnect @deprecated due to WalletConnect relicensing; still functional, pino override applied in root package.json
    (walletConnect as any)({ projectId }),
  ],
  chains: [baseSepolia, base, mainnet],
  transports: {
    [baseSepolia.id]: http('https://sepolia.base.org'),
    [base.id]:       http('https://base-rpc.publicnode.com'),
    [mainnet.id]:    http(),
  },
});
