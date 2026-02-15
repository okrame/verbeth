import { http, createConfig } from 'wagmi';
import { base, mainnet, baseSepolia} from 'wagmi/chains';
import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import {
  coinbaseWallet,
  metaMaskWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { getHttpUrlsForChain } from './src/chain.js';


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
    [baseSepolia.id]: http(getHttpUrlsForChain(baseSepolia.id)[0]),
    [base.id]:       http(getHttpUrlsForChain(base.id)[0]),
    [mainnet.id]:    http(),
  },
});
