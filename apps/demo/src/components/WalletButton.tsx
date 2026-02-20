import { useMemo, useState, useRef, useEffect } from 'react';
import { useAccount, useConnect, useSwitchChain, type Connector } from 'wagmi';
import { APP_CHAIN_ID } from '../chain.js';
import { AddressAvatar } from './AddressAvatar.js';

function WalletConnectLogo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 300 185" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M61.4385 36.2562C113.932 -15.4187 198.048 -15.4187 250.542 36.2562L256.288 41.9312C259.147 44.7483 259.147 49.3048 256.288 52.1219L236.407 71.7437C234.977 73.1523 232.644 73.1523 231.214 71.7437L223.268 63.8812C187.166 28.2969 112.813 28.2969 76.7115 63.8812L68.1885 72.3312C66.7583 73.7398 64.4255 73.7398 62.9953 72.3312L43.1141 52.7094C40.2552 49.8923 40.2552 45.3358 43.1141 42.5187L61.4385 36.2562ZM294.224 79.4219L311.976 97.0281C314.835 99.8452 314.835 104.402 311.976 107.219L229.818 188.327C226.959 191.144 222.293 191.144 219.434 188.327L160.36 129.834C159.645 129.12 158.478 129.12 157.763 129.834L98.6875 188.327C95.8286 191.144 91.1628 191.144 88.3039 188.327L6.02343 107.219C3.16457 104.402 3.16457 99.8452 6.02343 97.0281L23.7758 79.4219C26.6346 76.6048 31.3004 76.6048 34.1593 79.4219L93.2344 137.914C93.9492 138.629 95.1162 138.629 95.8311 137.914L154.907 79.4219C157.765 76.6048 162.431 76.6048 165.29 79.4219L224.366 137.914C225.08 138.629 226.247 138.629 226.962 137.914L286.038 79.4219C288.897 76.6048 293.563 76.6048 294.224 79.4219Z" fill="#3396FF"/>
    </svg>
  );
}

function ConnectorIcon({ connector, size = 24 }: { connector: Connector; size?: number }) {
  if (connector.icon) return <img src={connector.icon} alt="" className="rounded shrink-0" style={{ width: size, height: size }} />;
  if (connector.type === 'walletConnect') return <WalletConnectLogo size={size} />;
  return <div className="rounded bg-gray-700 shrink-0" style={{ width: size, height: size }} />;
}

/** EIP-6963 wallets first (with icons), generic fallback only if no real ones, WalletConnect last. */
function sortConnectors(connectors: readonly Connector[]): Connector[] {
  const eip6963 = connectors.filter(c => c.type === 'injected' && c.icon);
  const generic = connectors.filter(c => c.type === 'injected' && !c.icon);
  const wc = connectors.filter(c => c.type === 'walletConnect');
  const rest = connectors.filter(c => c.type !== 'injected' && c.type !== 'walletConnect');
  // Only show the generic "Injected" when no EIP-6963 wallet was discovered
  const injected = eip6963.length > 0 ? eip6963 : generic;
  return [...injected, ...rest, ...wc];
}

interface WalletButtonProps {
  pendingCount: number;
  isPanelOpen: boolean;
  onTogglePanel: () => void;
}

export function WalletButton({ pendingCount, isPanelOpen, onTogglePanel }: WalletButtonProps) {
  const { address, isConnected, chainId } = useAccount();
  const { connectors: rawConnectors, connect } = useConnect();
  const connectors = useMemo(() => sortConnectors(rawConnectors), [rawConnectors]);
  const { switchChain } = useSwitchChain();
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    if (!showDropdown) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDropdown]);

  // Not connected — show Connect button with connector dropdown
  if (!isConnected) {
    return (
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown(v => !v)}
          className="px-4 py-2 bg-white text-black rounded-lg font-medium text-sm hover:bg-gray-200 transition-colors"
        >
          Connect
        </button>

        {showDropdown && (
          <div className="absolute right-0 top-full mt-2 w-56 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden">
            {connectors.map((connector) => (
              <button
                key={connector.uid}
                onClick={() => {
                  connect({ connector });
                  setShowDropdown(false);
                }}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-800 transition-colors text-left"
              >
                <ConnectorIcon connector={connector} size={24} />
                <span className="text-sm text-white">{connector.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Connected but wrong chain
  if (chainId !== APP_CHAIN_ID) {
    return (
      <button
        onClick={() => switchChain({ chainId: APP_CHAIN_ID })}
        className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg font-medium text-sm transition-colors"
      >
        Wrong Network
      </button>
    );
  }

  // Connected, correct chain — show avatar + address, toggle panel
  const truncated = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '';

  return (
    <button
      onClick={onTogglePanel}
      className="relative flex items-center gap-2 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg hover:bg-gray-800 transition-colors"
    >
      <AddressAvatar address={address!} size={24} />
      <span className="text-sm text-white font-mono">{truncated}</span>
      {pendingCount > 0 && !isPanelOpen && (
        <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">
          {pendingCount}
        </span>
      )}
    </button>
  );
}
