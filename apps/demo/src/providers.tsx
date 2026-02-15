import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { config } from '../config.js';
import { APP_CHAIN_ID } from './chain.js';


const customTheme = darkTheme({
  accentColor: '#000000',
  accentColorForeground: '#ffffff',
  borderRadius: 'small',
  fontStack: 'system',
  overlayBlur: 'small',
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={customTheme}
          modalSize="compact"
          initialChain={APP_CHAIN_ID}
        > 
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
