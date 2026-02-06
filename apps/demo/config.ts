import { http, createConfig } from 'wagmi';
import { base, mainnet, baseSepolia} from 'wagmi/chains';
import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import {
  coinbaseWallet,
  metaMaskWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { BASESEPOLIA_HTTP_URL } from './src/rpc.js';


const projectId = 'abcd4fa063dd349643afb0bdc85bb248';
const name       = 'Unstoppable Chat';


//coinbaseWallet.preference = 'smartWalletOnly'; 

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Recommended',
      wallets: [
        metaMaskWallet],
    },
    {
      groupName: 'Other options',
      wallets: [walletConnectWallet],
    },
  ],
  { appName: name, projectId }
);

export const config = createConfig({
  connectors,
  chains: [baseSepolia, base, mainnet],
  transports: {
    [baseSepolia.id]: http(BASESEPOLIA_HTTP_URL),
    [base.id]:       http('https://base-rpc.publicnode.com'),
    [mainnet.id]:    http(),
  },
});