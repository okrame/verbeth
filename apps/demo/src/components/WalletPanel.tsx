import { useMemo, useState, useEffect, useRef } from 'react';
import { useAccount, useDisconnect, useConnect, useBalance, type Connector } from 'wagmi';
import { motion, AnimatePresence } from 'framer-motion';
import { CopyIcon, CheckIcon, PowerIcon, ChevronLeftIcon } from 'lucide-react';
import type { IdentityKeyPair } from '@verbeth/sdk';
import type { ExecutionMode, PendingHandshake, SyncProgress } from '../types.js';
import { AddressAvatar } from './AddressAvatar.js';
import { HistoryScanner } from './HistoryScanner.js';

function WalletConnectLogo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 300 185" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M61.4385 36.2562C113.932 -15.4187 198.048 -15.4187 250.542 36.2562L256.288 41.9312C259.147 44.7483 259.147 49.3048 256.288 52.1219L236.407 71.7437C234.977 73.1523 232.644 73.1523 231.214 71.7437L223.268 63.8812C187.166 28.2969 112.813 28.2969 76.7115 63.8812L68.1885 72.3312C66.7583 73.7398 64.4255 73.7398 62.9953 72.3312L43.1141 52.7094C40.2552 49.8923 40.2552 45.3358 43.1141 42.5187L61.4385 36.2562ZM294.224 79.4219L311.976 97.0281C314.835 99.8452 314.835 104.402 311.976 107.219L229.818 188.327C226.959 191.144 222.293 191.144 219.434 188.327L160.36 129.834C159.645 129.12 158.478 129.12 157.763 129.834L98.6875 188.327C95.8286 191.144 91.1628 191.144 88.3039 188.327L6.02343 107.219C3.16457 104.402 3.16457 99.8452 6.02343 97.0281L23.7758 79.4219C26.6346 76.6048 31.3004 76.6048 34.1593 79.4219L93.2344 137.914C93.9492 138.629 95.1162 138.629 95.8311 137.914L154.907 79.4219C157.765 76.6048 162.431 76.6048 165.29 79.4219L224.366 137.914C225.08 138.629 226.247 138.629 226.962 137.914L286.038 79.4219C288.897 76.6048 293.563 76.6048 294.224 79.4219Z" fill="#3396FF"/>
    </svg>
  );
}

function ConnectorIcon({ connector, size = 16 }: { connector: Connector; size?: number }) {
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
  const injected = eip6963.length > 0 ? eip6963 : generic;
  return [...injected, ...rest, ...wc];
}

interface WalletPanelProps {
  isOpen: boolean;
  onClose: () => void;
  identityKeyPair: IdentityKeyPair | null;
  executionMode: ExecutionMode | null;
  sessionSignerAddr: string | null;
  sessionSignerBalance: bigint | null;
  pendingHandshakes: PendingHandshake[];
  onAcceptHandshake: (h: PendingHandshake, msg: string) => void;
  onRejectHandshake: (id: string) => void;
  safeAddr?: string | null;
  // History scanner
  canLoadMore: boolean;
  isLoadingMore: boolean;
  backfillCooldown: boolean;
  syncProgress: SyncProgress | null;
  oldestScannedBlock: number | null;
  oldestScannedDate: Date | null;
  onLoadMore: () => void;
}

function useCopied() {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return { copied, copy };
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-5 py-2">
      <div className="flex-1 h-px bg-gray-700/60 ml-3" />
      <span className="text-[10px] text-gray-500 uppercase tracking-widest shrink-0">{label}</span>
      <div className="flex-1 h-px bg-gray-700/60 mr-3" />
    </div>
  );
}


const panelVariants = {
  hidden:  { opacity: 0, y: -8, scale: 0.97 },
  visible: { opacity: 1, y: 0,  scale: 1     },
  exit:    { opacity: 0, y: -8, scale: 0.97  },
};

export function WalletPanel({
  isOpen,
  onClose,
  identityKeyPair,
  executionMode,
  sessionSignerAddr,
  sessionSignerBalance,
  pendingHandshakes,
  onAcceptHandshake,
  onRejectHandshake,
  safeAddr,
  canLoadMore,
  isLoadingMore,
  backfillCooldown,
  syncProgress,
  oldestScannedBlock,
  oldestScannedDate,
  onLoadMore,
}: WalletPanelProps) {
  const { address } = useAccount();
  const { disconnect } = useDisconnect();
  const { connectors: rawConnectors, connect } = useConnect();
  const { data: balanceData } = useBalance({ address });
  const connectors = useMemo(() => sortConnectors(rawConnectors), [rawConnectors]);
  const [showPowerMenu, setShowPowerMenu] = useState(false);
  const [view, setView] = useState<'main' | 'connectors'>('main');
  const powerRef = useRef<HTMLDivElement>(null);
  const addrCopy = useCopied();
  const pubkeyCopy = useCopied();
  const safeCopy = useCopied();
  const signerCopy = useCopied();

  // Reset view when panel closes
  useEffect(() => {
    if (!isOpen) {
      setView('main');
      setShowPowerMenu(false);
    }
  }, [isOpen]);

  // Close power menu on click outside
  useEffect(() => {
    if (!showPowerMenu) return;
    const handler = (e: MouseEvent) => {
      if (powerRef.current && !powerRef.current.contains(e.target as Node)) {
        setShowPowerMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPowerMenu]);

  // Close panel on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const pubKeyHex = identityKeyPair
    ? Array.from(identityKeyPair.publicKey).map(b => b.toString(16).padStart(2, '0')).join('')
    : null;

  const formatBalance = (wei: bigint) => {
    if (wei === 0n) return '0.0000';
    const eth = Number(wei) / 1e18;
    return eth < 0.0001 ? '<0.0001' : eth.toFixed(4);
  };

  const showSession = (executionMode === 'fast' || executionMode === 'custom') && sessionSignerAddr;
  const showHistoryScanner = !!address && !!identityKeyPair;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop — transparent, click to close */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[9998]"
            onClick={onClose}
          />

          {/* Floating card */}
          <motion.div
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={panelVariants}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed right-4 top-16 sm:top-20 w-[380px] max-sm:left-4 max-sm:right-4 max-sm:w-auto bg-gray-900/85 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/50 rounded-2xl overflow-hidden z-[9999] flex flex-col"
          >
            {/* Header */}
            <div className="relative px-5 pt-5 pb-4 shrink-0">
              <div className="flex items-start gap-3 pr-8">
                {address && <AddressAvatar address={address} size={44} />}
                <div className="flex-1 min-w-0">
                  <button
                    onClick={() => address && addrCopy.copy(address)}
                    className="group flex items-center gap-1.5 text-sm font-mono text-white hover:text-gray-300 transition-colors"
                  >
                    <span>{address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ''}</span>
                    {addrCopy.copied
                      ? <CheckIcon size={14} className="text-green-400 shrink-0" />
                      : <CopyIcon size={14} className="text-gray-500 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                    }
                  </button>
                  {balanceData && (
                    <div className="text-xs text-gray-400 mt-0.5">
                      {formatBalance(balanceData.value)} ETH
                    </div>
                  )}
                </div>
              </div>

              {/* Power button — absolute top-right */}
              <div className="absolute top-3 right-3" ref={powerRef}>
                <button
                  onClick={() => setShowPowerMenu(v => !v)}
                  className="text-gray-500 hover:text-red-400 transition-colors p-1.5 rounded-lg hover:bg-white/5"
                >
                  <PowerIcon size={18} />
                </button>
                {showPowerMenu && (
                  <div className="absolute top-full right-0 mt-1 w-44 bg-gray-900 border border-gray-700 rounded-xl shadow-xl overflow-hidden">
                    <button
                      onClick={() => { disconnect(); setShowPowerMenu(false); onClose(); }}
                      className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-left text-red-400 hover:bg-gray-800 transition-colors"
                    >
                      <PowerIcon size={14} />
                      Disconnect
                    </button>
                    <div className="border-t border-gray-800" />
                    <button
                      onClick={() => { setView('connectors'); setShowPowerMenu(false); }}
                      className="w-full px-4 py-2.5 text-sm text-left text-gray-300 hover:bg-gray-800 transition-colors"
                    >
                      Switch wallet
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Content area with view transitions */}
            <AnimatePresence mode="wait">
              {view === 'main' ? (
                <motion.div
                  key="main"
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={{ duration: 0.15 }}
                  className="flex-1 overflow-y-auto custom-scrollbar max-h-[60vh]"
                >
                  {/* Verbeth section */}
                  {pubKeyHex && (
                    <>
                      <SectionDivider label="Verbeth" />
                      <div className="px-5 pb-3 space-y-2">
                        <div>
                          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">X25519 Public Key</div>
                          <button
                            onClick={() => pubkeyCopy.copy(pubKeyHex)}
                            className="group flex items-center gap-1.5 text-xs font-mono text-gray-300 hover:text-white transition-colors"
                          >
                            <span className="truncate">{pubKeyHex.slice(0, 6)}...{pubKeyHex.slice(-6)}</span>
                            {pubkeyCopy.copied
                              ? <CheckIcon size={12} className="text-green-400 shrink-0" />
                              : <CopyIcon size={12} className="text-gray-500 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                            }
                          </button>
                        </div>
                        {safeAddr && (
                          <div>
                            <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Executor (safe)</div>
                            <button
                              onClick={() => safeCopy.copy(safeAddr)}
                              className="group flex items-center gap-1.5 text-xs font-mono text-gray-300 hover:text-white transition-colors"
                            >
                              <span>{safeAddr.slice(0, 6)}...{safeAddr.slice(-4)}</span>
                              {safeCopy.copied
                                ? <CheckIcon size={12} className="text-green-400 shrink-0" />
                                : <CopyIcon size={12} className="text-gray-500 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                              }
                            </button>
                          </div>
                        )}
                        {showSession && sessionSignerAddr && (
                          <div>
                            <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1">Session signer</div>
                            <button
                              onClick={() => signerCopy.copy(sessionSignerAddr)}
                              className="group flex items-center gap-1.5 text-xs font-mono text-gray-300 hover:text-white transition-colors"
                            >
                              <span>{sessionSignerAddr.slice(0, 6)}...{sessionSignerAddr.slice(-4)}</span>
                              {signerCopy.copied
                                ? <CheckIcon size={12} className="text-green-400 shrink-0" />
                                : <CopyIcon size={12} className="text-gray-500 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                              }
                            </button>
                            {sessionSignerBalance !== null && (
                              <div className="text-xs text-gray-500 mt-0.5">{formatBalance(sessionSignerBalance)} ETH</div>
                            )}
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {/* Notifications section */}
                  <SectionDivider label="Notifications" />
                  <div className="px-5 pb-3">
                    {pendingHandshakes.length === 0 ? (
                      <p className="text-sm text-gray-600">No pending requests</p>
                    ) : (
                      <div className="space-y-3">
                        {pendingHandshakes.map((h) => (
                          <HandshakeCard
                            key={h.id}
                            handshake={h}
                            onAccept={onAcceptHandshake}
                            onReject={onRejectHandshake}
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Discover older inbox */}
                  {showHistoryScanner && (
                    <div className="px-2 pb-4">
                      <HistoryScanner
                        canLoadMore={canLoadMore}
                        isLoadingMore={isLoadingMore}
                        backfillCooldown={backfillCooldown}
                        syncProgress={syncProgress}
                        oldestScannedBlock={oldestScannedBlock}
                        oldestScannedDate={oldestScannedDate}
                        onLoadMore={onLoadMore}
                      />
                    </div>
                  )}
                </motion.div>
              ) : (
                <motion.div
                  key="connectors"
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 10 }}
                  transition={{ duration: 0.15 }}
                  className="flex-1 overflow-y-auto custom-scrollbar max-h-[60vh]"
                >
                  <button
                    onClick={() => setView('main')}
                    className="flex items-center gap-1.5 px-5 py-3 text-sm text-gray-400 hover:text-white transition-colors"
                  >
                    <ChevronLeftIcon size={16} />
                    Back
                  </button>
                  <div className="px-3 pb-4 space-y-0.5">
                    {connectors.map((c) => (
                      <button
                        key={c.uid}
                        onClick={() => { connect({ connector: c }); setView('main'); onClose(); }}
                        className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-white/5 transition-colors"
                      >
                        <span className="text-sm text-gray-300">{c.name}</span>
                        <ConnectorIcon connector={c} size={20} />
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/* ---------- Handshake request card (inline) ---------- */

function HandshakeCard({
  handshake,
  onAccept,
  onReject,
}: {
  handshake: PendingHandshake;
  onAccept: (h: PendingHandshake, msg: string) => void;
  onReject: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const note = inputRef.current?.value?.trim() ?? '';
    onAccept(handshake, note);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="border-l-2 border-white/15 pl-3 py-2.5 bg-white/[0.03] rounded-r-lg">
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <AddressAvatar address={handshake.sender} size={20} />
        <a
          href={`https://basescan.org/address/${handshake.sender}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-mono text-gray-300 hover:text-white transition-colors truncate"
        >
          {handshake.sender.slice(0, 6)}...{handshake.sender.slice(-4)}
        </a>
        {!handshake.verified && (
          <span className="text-[10px] font-mono text-amber-400 uppercase tracking-wide">
            ⚠ unverified
          </span>
        )}
        {handshake.isExistingContact && (
          <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">
            ↺ reset
          </span>
        )}
      </div>

      {handshake.message && (
        <p className="text-xs text-gray-500 mb-2 pl-6">"{handshake.message}"</p>
      )}

      <div className="flex items-center gap-2 pl-6">
        <input
          ref={inputRef}
          type="text"
          placeholder="note (optional)"
          className="flex-1 py-1 bg-transparent border-b border-white/10 focus:border-white/25 text-xs text-white placeholder-white/20 focus:outline-none transition-colors"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <button
          onClick={submit}
          className="px-2 py-1 text-xs text-white/70 hover:text-white border border-white/10 hover:border-white/20 rounded transition-colors"
        >
          Accept
        </button>
        <button
          onClick={() => onReject(handshake.id)}
          className="px-2 py-1 text-xs text-white/30 hover:text-red-400 transition-colors"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
