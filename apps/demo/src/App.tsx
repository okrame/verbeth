import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Fingerprint } from "lucide-react";
import { ConnectButton } from '@rainbow-me/rainbowkit';
import Safe from '@safe-global/protocol-kit'
import SafeApiKit from '@safe-global/api-kit'
import { useAccount, useWalletClient } from 'wagmi';
import { useRpcClients } from './rpc.js';
import { BrowserProvider, Wallet } from "ethers";
import {
  LogChainV1__factory,
  type LogChainV1,
} from "@verbeth/contracts/typechain-types/index.js";
import {
  IExecutor,
  ExecutorFactory,
  deriveIdentityKeyPairWithProof,
  IdentityKeyPair,
  IdentityProof,
  VerbethClient,
  SafeSessionSigner
} from '@verbeth/sdk';
import { useMessageListener } from './hooks/useMessageListener.js';
import { useMessageProcessor } from './hooks/useMessageProcessor.js';
import { dbService } from './services/DbService.js';
import {
  LOGCHAIN_SINGLETON_ADDR,
  CONTRACT_CREATION_BLOCK,
  Contact,
  StoredIdentity,
  SAFE_MODULE_ADDRESS,
  SAFE_TX_SERVICE_URL
} from './types.js';
import { InitialForm } from './components/InitialForm.js';
import { SideToastNotifications } from './components/SideToastNotification.js';
import { IdentityCreation } from './components/IdentityCreation.js';
import { CelebrationToast } from "./components/CelebrationToast.js";
import { useChatActions } from './hooks/useChatActions.js';



export default function App() {
  const { ethers: readProvider, viem: viemClient } = useRpcClients();
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [ready, setReady] = useState(false);
  const [recipientAddress, setRecipientAddress] = useState("");
  const [message, setMessage] = useState("");
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentAccount, setCurrentAccount] = useState<string | null>(null);
  const [showHandshakeForm, setShowHandshakeForm] = useState(true);
  const [handshakeToasts, setHandshakeToasts] = useState<any[]>([]);
  const [needsIdentityCreation, setNeedsIdentityCreation] = useState(false);
  const [showToast, setShowToast] = useState(false);

  const [identityKeyPair, setIdentityKeyPair] = useState<IdentityKeyPair | null>(null);
  const [identityProof, setIdentityProof] = useState<IdentityProof | null>(null);
  const [executor, setExecutor] = useState<IExecutor | null>(null);
  const [contract, setContract] = useState<LogChainV1 | null>(null);
  const [signer, setSigner] = useState<any>(null);
  const [isActivityLogOpen, setIsActivityLogOpen] = useState(false);
  const [activityLogs, setActivityLogs] = useState<string>("");

  const [verbethClient, setVerbethClient] = useState<VerbethClient | null>(null);

  const logRef = useRef<HTMLTextAreaElement>(null);

  // Identity context (domain and chain binding)
  const chainId = Number(import.meta.env.VITE_CHAIN_ID);
  const rpId = globalThis.location?.host ?? "";
  const identityContext = useMemo(() => ({ chainId, rpId }), [chainId, rpId]);

  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}\n`;

    setActivityLogs(prev => {
      const newLogs = prev + logEntry;

      setTimeout(() => {
        if (logRef.current && isActivityLogOpen) {
          logRef.current.scrollTop = logRef.current.scrollHeight;
        }
      }, 0);

      return newLogs;
    });
  }, [isActivityLogOpen]);


  const createIdentity = useCallback(async () => {
    // Wagmi
    if (signer && address) {
      setLoading(true);
      try {
        addLog("Deriving new identity key (2 signatures)...");

        const result = await deriveIdentityKeyPairWithProof(signer, address, identityContext);

        setIdentityKeyPair(result.keyPair);
        setIdentityProof(result.identityProof);

        const identityToStore: StoredIdentity = {
          address: address,
          keyPair: result.keyPair,
          derivedAt: Date.now(),
          proof: result.identityProof
        };

        await dbService.saveIdentity(identityToStore);
        addLog(`New identity key derived and saved for EOA`);
        setNeedsIdentityCreation(false);
        setShowToast(true);

      } catch (signError: any) {
        if (signError.code === 4001) {
          addLog("User rejected signing request.");
        } else {
          addLog(`✗ Failed to derive identity: ${signError.message}`);
        }
      } finally {
        setLoading(false);
      }
      return;
    }

    addLog("✗ Missing signer/provider or address for identity creation");
  }, [signer, address, identityContext, addLog]);

  const {
    messages,
    pendingHandshakes,
    contacts,
    addMessage,
    removePendingHandshake,
    updateContact,
    processEvents
  } = useMessageProcessor({
    readProvider,
    identityContext,
    address: address ?? undefined,
    identityKeyPair,
    onLog: addLog
  });

  const {
    isInitialLoading,
    isLoadingMore,
    canLoadMore,
    syncProgress,
    loadMoreHistory,
  } = useMessageListener({
    readProvider,
    address: address ?? undefined,
    onLog: addLog,
    onEventsProcessed: processEvents
  });

  const {
    sendHandshake,
    acceptHandshake,
    sendMessageToContact
  } = useChatActions({
    verbethClient,
    addLog,
    updateContact: async (contact: Contact) => { await updateContact(contact); },
    addMessage: async (message: any) => { await addMessage(message); },
    removePendingHandshake: async (id: string) => { await removePendingHandshake(id); },
    setSelectedContact,
    setLoading,
    setMessage,
    setRecipientAddress,
  });

  useEffect(() => {
    const currentAddress = address;

    if (executor && identityKeyPair && identityProof && signer && currentAddress) {
      const client = new VerbethClient({
        executor,
        identityKeyPair,
        identityProof,
        signer,
        address: currentAddress,
      });
      setVerbethClient(client);
      addLog(`VerbethClient initialized for ${currentAddress.slice(0, 8)}...`);
    } else {
      setVerbethClient(null);
    }
  }, [executor, identityKeyPair, identityProof, signer, address, addLog]);

  // sync handshakeToasts
  useEffect(() => {
    const currentlyConnected = isConnected;
    const currentAddress = address;

    if (!currentlyConnected || !currentAddress || !identityKeyPair) {
      setHandshakeToasts([]);
      return;
    }

    setHandshakeToasts(
      pendingHandshakes.map((h) => ({
        id: h.id,
        sender: h.sender,
        message: h.message,
        verified: h.verified,
        onAccept: (msg: string) => acceptHandshake(h, msg),
        onReject: () => removePendingHandshake(h.id),
      }))
    );
  }, [pendingHandshakes, isConnected, address, identityKeyPair]);

  const removeToast = (id: string) => {
    setHandshakeToasts((prev) => prev.filter((n) => n.id !== id));
  };

  useEffect(() => {
    setReady(readProvider !== null && isConnected && walletClient !== undefined);
  }, [readProvider, isConnected, walletClient]);

  useEffect(() => {
    handleInitialization();
  }, [ready, readProvider, walletClient, address]);

  // hide handshake form when we have contacts AND user is connected
  useEffect(() => {
    const currentlyConnected = isConnected;
    setShowHandshakeForm(!ready || !currentlyConnected || contacts.length === 0 || needsIdentityCreation);
  }, [ready, isConnected, contacts.length, needsIdentityCreation]);

  const handleInitialization = useCallback(async () => {
    try {
      if (ready && readProvider && walletClient && address) {
        await initializeWagmiAccount();
        return;
      }

      if (!address) {
        resetState();
      }
    } catch (error) {
      console.error("Failed to initialize:", error);
      addLog(`✗ Failed to initialize: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }, [ready, readProvider, walletClient, address]);

  const initializeWagmiAccount = async () => {
    const ethersProvider = new BrowserProvider(walletClient!.transport);
    const ethersSigner = await ethersProvider.getSigner();

    const net = await ethersProvider.getNetwork();
    if (Number(net.chainId) !== chainId) {
      addLog(`Wrong network: connected to chain ${Number(net.chainId)}, expected ${chainId}. Please switch network in your wallet.`);
      return;
    }

    const contractInstance = LogChainV1__factory.connect(LOGCHAIN_SINGLETON_ADDR, ethersSigner as any);
    const executorInstance = ExecutorFactory.createEOA(contractInstance);

    setSigner(ethersSigner);
    setExecutor(executorInstance);
    setContract(contractInstance);

    if (address !== currentAccount) {
      console.log(`EOA connected: ${address!.slice(0, 8)}...`);
      await switchToAccount(address!);
    }
  };

  const switchToAccount = async (newAddress: string) => {
    setIdentityKeyPair(null);
    setIdentityProof(null);
    setSelectedContact(null);

    await dbService.switchAccount(newAddress);
    setCurrentAccount(newAddress);

    const storedIdentity = await dbService.getIdentity(newAddress);
    if (storedIdentity) {
      setIdentityKeyPair(storedIdentity.keyPair);
      setIdentityProof(storedIdentity.proof ?? null);
      setNeedsIdentityCreation(false);
      addLog(`Identity keys restored from database`);
    } else {
      setNeedsIdentityCreation(true);
    }
  };

  const resetState = () => {
    setCurrentAccount(null);
    setIdentityKeyPair(null);
    setIdentityProof(null);
    setSelectedContact(null);
    setSigner(null);
    setContract(null);
    setExecutor(null);
    setNeedsIdentityCreation(false);
    setVerbethClient(null);
  };


  return (
    <div className="min-h-screen bg-black text-white">
      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(17, 24, 39, 0.5);
          border-radius: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(75, 85, 99, 0.8);
          border-radius: 4px;
          transition: background 0.2s ease;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(107, 114, 128, 1);
        }
        .custom-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: rgba(75, 85, 99, 0.8) rgba(17, 24, 39, 0.5);
        }
      `}</style>
      <div className="w-full bg-black relative">
        <div className="flex justify-between items-start px-2 sm:px-4 py-2 sm:py-4">
          {/* LEFT: title */}
          <div className="flex flex-col items-start">
            <h1 className="text-2xl sm:text-4xl font-extrabold leading-tight">
              Unstoppable Chat
            </h1>
            <div className="text-xs text-gray-400 pl-0.5 mt-1">
              powered by Verbeth
            </div>
          </div>
          {/* RIGHT: auth buttons - EOA only */}
          <div className="flex items-start gap-px sm:gap-px">
            {!isConnected ? (
              <div className="flex flex-col items-end -space-y-1 sm:space-y-0 sm:gap-px">
                <div className="border border-gray-400 rounded-lg p-0.5 w-full flex justify-center scale-75 sm:scale-100 origin-top-right">
                  <ConnectButton />
                </div>
              </div>
            ) : (
              <div className="border border-gray-600 rounded-lg p-0.5 w-full flex justify-center scale-75 sm:scale-100 origin-top-right">
                <ConnectButton />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main content with max-width */}
      <div className="max-w-6xl mx-auto pt-px px-2 sm:px-4 pb-4 flex flex-col min-h-[80vh]">
        <div className="flex-1 flex flex-col pb-32 sm:pb-24">
          <div className="flex-1 flex flex-col">

            {/* Handshake Toast Notifiche */}
            <SideToastNotifications
              notifications={handshakeToasts}
              removeNotification={removeToast}
            />

            <CelebrationToast show={showToast} onClose={() => setShowToast(false)} />

            {needsIdentityCreation ? (
              <IdentityCreation
                loading={loading}
                onCreateIdentity={createIdentity}
                address={address || "Not connected"}
              />
            ) : showHandshakeForm ? (
              <InitialForm
                isConnected={isConnected}
                loading={loading}
                recipientAddress={recipientAddress}
                setRecipientAddress={setRecipientAddress}
                message={message}
                setMessage={setMessage}
                onSendHandshake={() => sendHandshake(recipientAddress, message)}
                contactsLength={isConnected ? contacts.length : 0}
                onBackToChats={() => setShowHandshakeForm(false)}
                hasExistingIdentity={!needsIdentityCreation}
              />
            ) : (
              <div className="relative">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 min-h-[650px] pb-52">
                  {/* Left Panel - Contacts */}
                  <div className="border border-gray-800 bg-gray-800/30 rounded-lg p-4">
                    <div className="flex justify-between items-center mb-4">
                      <h2 className="text-lg font-semibold">Contacts</h2>
                      <button
                        onClick={() => setShowHandshakeForm(true)}
                        className="text-sm text-blue-400 hover:text-blue-300"
                      >
                        + New
                      </button>
                    </div>
                    <div className="space-y-2">
                      {contacts.map((contact) => (
                        <div
                          key={contact.address}
                          onClick={() => setSelectedContact(contact)}
                          className={`p-3 rounded cursor-pointer transition-colors ${selectedContact?.address === contact.address
                            ? 'bg-gray-700'
                            : 'bg-gray-800 hover:bg-gray-750'
                            }`}
                        >
                          <div className="flex justify-between items-start">
                            <span className="font-mono text-sm">
                              {contact.address.slice(0, 8)}...{contact.address.slice(-6)}
                            </span>
                            <span className={`text-xs px-2 py-1 rounded ${contact.status === 'established'
                              ? 'bg-green-900 text-green-300'
                              : 'bg-yellow-900 text-yellow-300'
                              }`}>
                              {contact.status === 'established' ? '✓' : '...'}
                            </span>
                          </div>
                          {contact.lastMessage && (
                            <p className="text-xs text-gray-400 mt-1 truncate">
                              {contact.lastMessage}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Right Panel - Conversation */}
                  <div className="lg:col-span-2 border border-gray-800 bg-gray-800/40 rounded-lg p-4 flex flex-col h-[650px]">
                    <h2 className="text-lg font-semibold mb-4">
                      {selectedContact ? `Chat with ${selectedContact.address.slice(0, 8)}...` : 'Select a contact'}
                    </h2>

                    {selectedContact ? (
                      <>
                        {/* Load More History Button */}
                        {canLoadMore && (
                          <div className="text-center mb-2">
                            <button
                              onClick={loadMoreHistory}
                              disabled={isLoadingMore}
                              className="px-3 py-1 text-sm bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed rounded"
                            >
                              {isLoadingMore ? (
                                <span className="flex items-center gap-2">
                                  <span className="animate-spin w-3 h-3 border border-gray-400 border-t-transparent rounded-full"></span>
                                  <span>Loading...</span>
                                  {syncProgress && <span>({syncProgress.current}/{syncProgress.total})</span>}
                                </span>
                              ) : (
                                "📂 Load More History"
                              )}
                            </button>
                          </div>
                        )}

                        {/* Messages */}
                        <div className="flex-1 min-h-0 overflow-y-auto space-y-2 mb-4 pr-2 custom-scrollbar">
                          {messages
                            .filter(m => {
                              const currentAddress = address;
                              if (!currentAddress || !selectedContact?.address) return false;
                              return (
                                m.sender.toLowerCase() === selectedContact.address.toLowerCase() ||
                                (m.direction === 'outgoing' && m.recipient?.toLowerCase() === selectedContact.address.toLowerCase()) ||
                                (selectedContact.topicOutbound && m.topic === selectedContact.topicOutbound) ||
                                (selectedContact.topicInbound && m.topic === selectedContact.topicInbound)
                              );
                            })
                            .sort((a, b) => a.timestamp - b.timestamp)
                            .map((msg) => (
                              <div
                                key={msg.id}
                                className={`max-w-[80%] p-3 rounded-lg ${msg.direction === 'outgoing'
                                  ? 'ml-auto bg-blue-600'
                                  : 'bg-gray-700'
                                  } ${msg.type === 'system' ? 'bg-gray-800 text-gray-400 italic' : ''}`}
                              >
                                <p className="text-sm flex items-center gap-1">
                                  {msg.type === "system" && msg.verified !== undefined && (
                                    msg.verified ? (
                                      <span className="relative group cursor-help">
                                        <Fingerprint size={14} className="text-green-400 inline-block mr-1" />
                                        <span className="absolute bottom-full left-0 mb-1 px-2 py-1 text-xs rounded bg-gray-900 text-green-100 border border-gray-700 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-50">
                                          Identity proof verified
                                        </span>
                                      </span>
                                    ) : (
                                      <span className="relative group cursor-help">
                                        <Fingerprint size={14} className="text-red-400 inline-block mr-1" />
                                        <span className="absolute bottom-full left-0 mb-1 px-2 py-1 text-xs rounded bg-gray-900 text-red-100 border border-gray-700 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-50">
                                          Identity proof not verified
                                        </span>
                                      </span>
                                    )
                                  )}

                                  {msg.type === "system" && msg.decrypted ? (
                                    <>
                                      <span className="font-bold">{msg.decrypted.split(":")[0]}:</span>
                                      {msg.decrypted.split(":").slice(1).join(":")}
                                    </>
                                  ) : (
                                    msg.decrypted || msg.ciphertext
                                  )}
                                </p>

                                <div className="flex justify-between items-center mt-1">
                                  <span className="text-xs text-gray-300">
                                    {new Date(msg.timestamp).toLocaleTimeString()}
                                  </span>
                                  {msg.direction === 'outgoing' && (
                                    <span className="text-xs" title={`Status: ${msg.status}`}>
                                      {msg.status === 'confirmed' ? '✓✓' :
                                        msg.status === 'failed' ? '✗' :
                                          msg.status === 'pending' ? '✓' : '?'}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                          {messages.filter(m => {
                            const currentAddress = address;
                            if (!currentAddress || !selectedContact?.address) return false;
                            return (
                              m.sender.toLowerCase() === selectedContact.address.toLowerCase() ||
                              (m.direction === 'outgoing' && m.recipient?.toLowerCase() === selectedContact.address.toLowerCase()) ||
                              (selectedContact.topicOutbound && m.topic === selectedContact.topicOutbound) ||
                              (selectedContact.topicInbound && m.topic === selectedContact.topicInbound)
                            );
                          }).length === 0 && (
                              <p className="text-gray-400 text-sm text-center py-8">
                                No messages yet. {selectedContact.status === 'established' ? 'Start the conversation!' : 'Waiting for handshake completion.'}
                              </p>
                            )}
                        </div>

                        {/* Message Input */}
                        {selectedContact.status === 'established' && selectedContact.identityPubKey && (
                          <div className="flex gap-2">
                            <input
                              type="text"
                              placeholder="Type a message..."
                              className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                                  sendMessageToContact(selectedContact, e.currentTarget.value.trim());
                                  e.currentTarget.value = '';
                                }
                              }}
                            />
                            <button
                              onClick={() => {
                                const input = document.querySelector('input[placeholder="Type a message..."]') as HTMLInputElement;
                                if (input?.value.trim()) {
                                  sendMessageToContact(selectedContact, input.value.trim());
                                  input.value = '';
                                }
                              }}
                              disabled={loading}
                              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded"
                            >
                              Send
                            </button>
                          </div>
                        )}

                        {selectedContact.status !== 'established' && (
                          <div className="text-center py-4 text-gray-400 text-sm">
                            Handshake in progress... waiting for response
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="flex-1 flex items-center justify-center text-gray-400">
                        Select a contact to start messaging
                      </div>
                    )}
                  </div>
                </div>

                {/* Activity Log + Debug Info */}
                {ready && (
                  <div className="absolute bottom-[10px] left-0 right-0 w-full flex flex-col gap-1 sm:gap-2 px-1 sm:px-2 md:px-4 pointer-events-none z-50">
                    <div className="max-w-6xl w-full pointer-events-auto">
                      <div
                        className="flex justify-between items-center p-2 sm:p-4 cursor-pointer hover:bg-gray-900/50 transition-colors"
                        onClick={() => setIsActivityLogOpen(!isActivityLogOpen)}
                      >
                        <div className="flex items-center gap-2 sm:gap-4">
                          <div className="flex items-center gap-1 sm:gap-2">
                            <h2 className="text-sm sm:text-lg font-semibold">Activity Log</h2>
                            <span className="text-gray-400 text-sm">
                              {isActivityLogOpen ? '▼' : '▶'}
                            </span>
                          </div>
                          {canLoadMore && ready && isActivityLogOpen && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                loadMoreHistory();
                              }}
                              disabled={isLoadingMore}
                              className="px-3 py-1 text-sm bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed rounded flex items-center gap-2"
                            >
                              {isLoadingMore ? (
                                <>
                                  <div className="animate-spin w-3 h-3 border border-gray-400 border-t-transparent rounded-full"></div>
                                  <span>Loading blocks...</span>
                                </>
                              ) : (
                                <>
                                  <span>📂</span>
                                  <span>Load More History</span>
                                </>
                              )}
                            </button>
                          )}
                        </div>
                        {(isInitialLoading || isLoadingMore) && isActivityLogOpen && (
                          <div className="flex items-center gap-2 text-sm text-blue-400">
                            <div className="animate-spin w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full"></div>
                            <span>{isInitialLoading ? 'Initial sync...' : 'Loading more...'}</span>
                            {syncProgress && (
                              <span>({syncProgress.current}/{syncProgress.total})</span>
                            )}
                          </div>
                        )}
                      </div>

                      <div
                        className={`overflow-hidden transition-all duration-300 ease-in-out ${isActivityLogOpen ? 'max-h-40 opacity-100' : 'max-h-0 opacity-0'}`}
                      >
                        <div className="p-4 pt-0">
                          <textarea
                            ref={logRef}
                            readOnly
                            value={activityLogs}
                            className="w-full h-32 bg-gray-900 border border-gray-700 rounded p-2 text-sm font-mono text-gray-300 resize-none"
                            placeholder="Activity will appear here..."
                          />
                        </div>
                      </div>
                    </div>

                    {!isActivityLogOpen && (
                      <div className="w-full bg-black/80 backdrop-blur-sm p-2 sm:p-3 text-xs text-gray-500 space-y-1 h-fit">
                        <p>Contract: {LOGCHAIN_SINGLETON_ADDR}</p>
                        <p>Network: Base (Chain ID: {chainId})</p>
                        <p>Contract creation block: {CONTRACT_CREATION_BLOCK}</p>
                        <p>Status: {ready ? '🟢 Ready' : '🔴 Not Ready'} {(isInitialLoading || isLoadingMore) ? '⏳ Loading' : ''}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}