import { useEffect, useRef, useState, useCallback } from "react";
import { CopyIcon, Fingerprint, X } from "lucide-react";
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useWalletClient } from 'wagmi';
import { useRpcClients } from './rpc.js';
import { BrowserProvider } from "ethers";
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
} from '@verbeth/sdk';
import { useMessageListener } from './hooks/useMessageListener.js';
import { useMessageProcessor } from './hooks/useMessageProcessor.js';
import { dbService } from './services/DbService.js';
import {
  LOGCHAIN_SINGLETON_ADDR,
  CONTRACT_CREATION_BLOCK,
  Contact,
  StoredIdentity,
} from './types.js';
import { InitialForm } from './components/InitialForm.js';
import { SideToastNotifications } from './components/SideToastNotification.js';
import { IdentityCreation } from './components/IdentityCreation.js';
import { CelebrationToast } from "./components/CelebrationToast.js";
import { createBaseAccountSDK } from '@base-org/account';
import { SignInWithBaseButton } from '@base-org/account-ui/react';
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

  const [baseSDK, setBaseSDK] = useState<ReturnType<typeof createBaseAccountSDK> | null>(null);
  const [baseProvider, setBaseProvider] = useState<any>(null);
  const [baseAddress, setBaseAddress] = useState<string | null>(null);
  const [isBaseConnected, setIsBaseConnected] = useState(false);

  const logRef = useRef<HTMLTextAreaElement>(null);

  const chainId = Number(import.meta.env.VITE_CHAIN_ID);

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
        addLog("Deriving new identity key (EOA)...");

        const result = await deriveIdentityKeyPairWithProof(signer, address);

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

    // Base SDK
    if (baseProvider && baseAddress) {
      setLoading(true);
      try {
        addLog("Deriving new identity key (Base Smart Account)...");

        const result = await deriveIdentityKeyPairWithProof(signer, baseAddress);

        console.log("!!!!Debug🔑 [createIdentity] identityProof:", result.identityProof);

        setIdentityKeyPair(result.keyPair);
        setIdentityProof(result.identityProof);

        const identityToStore: StoredIdentity = {
          address: baseAddress,
          keyPair: result.keyPair,
          derivedAt: Date.now(),
          proof: result.identityProof
        };

        await dbService.saveIdentity(identityToStore);
        addLog(`New identity key derived and saved for Base Smart Account`);
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
  }, [signer, address, baseProvider, baseAddress, addLog]);

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
    address: address ?? baseAddress ?? undefined,
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
    address: address ?? baseAddress ?? undefined,
    onLog: addLog,
    onEventsProcessed: processEvents
  });

  const {
    sendHandshake,
    acceptHandshake,
    sendMessageToContact
  } = useChatActions({
    address,
    baseAddress,
    baseProvider,
    signer,
    executor,
    identityKeyPair,
    identityProof,
    addLog,
    updateContact: async (contact: Contact) => { await updateContact(contact); },
    addMessage: async (message: any) => { await addMessage(message); },
    removePendingHandshake: async (id: string) => { await removePendingHandshake(id); },
    setSelectedContact,
    setLoading,
    setMessage,
    setRecipientAddress,
  });

  // sync handshakeToasts
  useEffect(() => {
    const currentlyConnected = isConnected || isBaseConnected;
    const currentAddress = address || baseAddress;

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
  }, [pendingHandshakes, isConnected, isBaseConnected, address, baseAddress, identityKeyPair]);

  const removeToast = (id: string) => {
    setHandshakeToasts((prev) => prev.filter((n) => n.id !== id));
  };

  useEffect(() => {
    setReady(
      (readProvider !== null && isConnected && walletClient !== undefined) ||
      (baseProvider !== null && isBaseConnected)
    );
  }, [readProvider, isConnected, walletClient, baseProvider, isBaseConnected]);

  useEffect(() => {
    handleInitialization();
  }, [ready, readProvider, walletClient, address]);

  // hide handshake form when we have contacts AND user is connected
  useEffect(() => {
    const currentlyConnected = isConnected || isBaseConnected;
    setShowHandshakeForm(!ready || !currentlyConnected || contacts.length === 0 || needsIdentityCreation);
  }, [ready, isConnected, isBaseConnected, contacts.length, needsIdentityCreation]);

  const handleInitialization = useCallback(async () => {
    try {
      if (ready && readProvider && walletClient && address && !baseAddress) {
        await initializeWagmiAccount();
        return;
      }

      if (isBaseConnected && baseProvider && baseAddress && !address) {
        await initializeBaseAccount();
        return;
      }

      if (!address && !baseAddress) {
        resetState();
      }
    } catch (error) {
      console.error("Failed to initialize:", error);
      addLog(`✗ Failed to initialize: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }, [ready, readProvider, walletClient, address, baseAddress, isBaseConnected, baseProvider]);

  const initializeWagmiAccount = async () => {
    const ethersProvider = new BrowserProvider(walletClient!.transport);
    const ethersSigner = await ethersProvider.getSigner();

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

  const initializeBaseAccount = async () => {
    const paymasterUrl = import.meta.env.VITE_PAYMASTER_AND_BUNDLER_ENDPOINT;

    const executorInstance = ExecutorFactory.createBaseSmartAccount(
      baseProvider,
      LOGCHAIN_SINGLETON_ADDR,
      chainId,
      paymasterUrl
    );

    const browserProvider = new BrowserProvider(baseProvider);
    const realSigner = await browserProvider.getSigner(baseAddress!);

    setSigner(realSigner);
    setExecutor(executorInstance);

    if (baseAddress !== currentAccount) {
      console.log(`Base Smart Account connected: ${baseAddress!.slice(0, 8)}...`);
      await switchToAccount(baseAddress!);
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
  };

  const initializeBaseSDK = useCallback(async () => {
    if (!baseSDK) {
      const sdk = createBaseAccountSDK({
        appName: 'Unstoppable Chat',
        //appLogoUrl: 'https://base.org/logo.png',
        appChainIds: [chainId],
      });

      const provider = sdk.getProvider();
      setBaseSDK(sdk);
      setBaseProvider(provider);

      // Listen for account changes
      provider.on('accountsChanged', (accounts: string[]) => {
        if (accounts.length > 0) {
          const newAddress = accounts[0];

          if (baseAddress && newAddress !== baseAddress) {
            addLog(`Base Account changed from ${baseAddress.slice(0, 8)}... to ${newAddress.slice(0, 8)}...`);
            resetState();
          }

          setBaseAddress(newAddress);
          setIsBaseConnected(true);
        } else {
          addLog("Base Account disconnected");
          setBaseAddress(null);
          setIsBaseConnected(false);
          resetState();
        }
      });

      provider.on('disconnect', () => {
        addLog("Base Account provider disconnected");
        setBaseAddress(null);
        setIsBaseConnected(false);
        resetState();
      });
    }
  }, [baseSDK, baseAddress, addLog]);

  const connectBaseAccount = async () => {
    if (!baseProvider) {
      initializeBaseSDK();
      return;
    }
    try {
      const accounts = await baseProvider.request({
        method: "eth_requestAccounts",
        params: [],
      }) as string[];

      if (accounts.length > 0) {
        setBaseAddress(accounts[0]);
        setIsBaseConnected(true);
      }
    } catch (error) {
      console.error('Base account connection failed:', error);
    }
  };

  const disconnectBaseAccount = () => {
    if (baseProvider) {
      baseProvider.disconnect?.().catch((error: any) => {
        console.log(`Disconnect error: ${error.message}`);
      });
    }
    setBaseAddress(null);
    setIsBaseConnected(false);
    resetState();
    addLog("Base Account disconnected - state reset");
    //localStorage.removeItem("base-acc-sdk.store");
  };

  useEffect(() => {
    initializeBaseSDK();
  }, [initializeBaseSDK]);


  // const handleVerifyMessage = useCallback(async () => {
  //   if (!viemClient || !identityProof) {
  //     addLog("⚠ Missing viem client or identity proof for verification");
  //     return;
  //   }
  //   const currentAddress = address || baseAddress;
  //   if (!currentAddress) {
  //     addLog("⚠ No connected address for verification");
  //     return;
  //   }

  //   setLoading(true);
  //   try {
  //     addLog("🔍 Verifying stored identity proof...");
  //     const { message, signature } = identityProof;

  //     const ok = await viemClient.verifyMessage({
  //       address: currentAddress as `0x${string}`,
  //       message,
  //       signature: signature as `0x${string}`,
  //     });

  //     setVerificationResult(ok ? "valid" : "invalid");
  //     addLog(`✅ Identity proof verification: ${ok ? "VALID" : "INVALID"}`);
  //   } catch (e: any) {
  //     console.error(e);
  //     setVerificationResult("invalid");
  //     addLog(`⚠ Verification failed: ${e?.message ?? e}`);
  //   } finally {
  //     setLoading(false);
  //   }
  // }, [viemClient, identityProof, address, baseAddress, addLog]);

  return (
    <div className="min-h-screen bg-black text-white">
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
          {/* RIGHT: auth buttons */}
          <div className="flex items-start gap-px sm:gap-px">
            {!isConnected && !isBaseConnected ? (
              <div className="flex flex-col items-end -space-y-1 sm:space-y-0 sm:gap-px">
                <div className="scale-75 sm:scale-100 origin-top-right">
                  <SignInWithBaseButton
                    align="center"
                    variant="solid"
                    colorScheme="system"
                    onClick={connectBaseAccount}
                  />
                </div>
                <div className="text-xs text-gray-400 text-left w-fit self-start -ml-6 my-0 hidden sm:block">
                  Or
                </div>

                <div className="border border-gray-400 rounded-lg p-0.5 w-full flex justify-center scale-75 sm:scale-100 origin-top-right">
                  <ConnectButton />
                </div>
              </div>
            ) : isConnected ? (
              <div className="border border-gray-600 rounded-lg p-0.5 w-full flex justify-center scale-75 sm:scale-100 origin-top-right">
                <ConnectButton />
              </div>
            ) : (
              <div className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1 sm:py-2 border border-gray-600 rounded-lg text-sm sm:text-base">
                <span className="text-sm flex items-center gap-1">
                  {baseAddress?.slice(0, 8)}...{baseAddress?.slice(-6)}
                  <span title="Copia indirizzo">
                    <CopyIcon
                      size={16}
                      className="
      ml-1 text-gray-400 hover:text-white cursor-pointer transition 
      active:scale-90 hover:scale-110
    "
                      onClick={async () => {
                        if (baseAddress) { await navigator.clipboard.writeText(baseAddress); }
                      }}
                    />
                  </span>
                </span>
                <button
                  onClick={disconnectBaseAccount}
                  className="text-xs text-gray-400 hover:text-white"
                >
                  Sign out
                </button>
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

            {/* Identity Proof Verification Section
            {ready && (isConnected || isBaseConnected) && !needsIdentityCreation && identityProof && (
              <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-4 mb-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold">Identity Proof Verification</h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleVerifyMessage}
                      disabled={loading}
                      className="px-3 py-2 text-sm bg-green-700 hover:bg-green-600 disabled:bg-gray-800 disabled:cursor-not-allowed rounded"
                    >
                      {loading ? "Verifying..." : "Verify Stored Proof"}
                    </button>

                    {verificationResult && (
                      <span className={`text-sm px-3 py-1 rounded ${verificationResult === "valid"
                        ? "bg-green-800 text-green-200"
                        : "bg-red-800 text-red-200"
                        }`}>
                        {verificationResult.toUpperCase()}
                      </span>
                    )}
                  </div>
                </div> */}

            {/* Display stored proof data */}
            {/* <div className="space-y-3 text-sm">
                  <div className="bg-gray-800 rounded p-3">
                    <p className="text-gray-400 mb-1">Connected Address:</p>
                    <p className="font-mono text-blue-400 break-all">
                      {address || baseAddress || "Not connected"}
                    </p>
                  </div>

                  <div className="bg-gray-800 rounded p-3">
                    <p className="text-gray-400 mb-1">Stored Proof Message:</p>
                    <p className="font-mono text-green-400 break-all">{identityProof.message}</p>
                  </div>

                  <div className="bg-gray-800 rounded p-3">
                    <p className="text-gray-400 mb-1">Stored Proof Signature:</p>
                    <p className="font-mono text-yellow-400 break-all text-xs">
                      {identityProof.signature}
                    </p>
                  </div>
                </div>
              </div>
            )} */}

            {needsIdentityCreation ? (
              <IdentityCreation
                loading={loading}
                onCreateIdentity={createIdentity}
                address={address || baseAddress || "Not connected"}
              />
            ) : showHandshakeForm ? (
              <InitialForm
                isConnected={isConnected}
                isBaseConnected={isBaseConnected}
                loading={loading}
                recipientAddress={recipientAddress}
                setRecipientAddress={setRecipientAddress}
                message={message}
                setMessage={setMessage}
                onSendHandshake={() => sendHandshake(recipientAddress, message)}
                contactsLength={isConnected || isBaseConnected ? contacts.length : 0}
                onBackToChats={isConnected || isBaseConnected && contacts.length > 0 ? () => setShowHandshakeForm(false) : undefined}
                onConnectBase={connectBaseAccount}
                hasExistingIdentity={!needsIdentityCreation}
              />
            ) : (
              <div className="relative">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 min-h-[800px] pb-52">


                  {/* Left Panel - Contacts */}
                  <div className="border border-gray-800 bg-gray-800/30 rounded-lg p-4">
                    <div className="flex justify-between items-center mb-4">
                      <h2 className="text-lg font-semibold">Contacts</h2>
                      <button
                        onClick={() => setShowHandshakeForm(true)}
                        className="text-sm px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded"
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
                            ? 'bg-blue-900'
                            : 'bg-gray-900 hover:bg-gray-800'
                            }`}
                        >
                          <div className="flex justify-between items-center">
                            <span className="text-sm font-medium">
                              {contact.address.slice(0, 8)}...
                            </span>
                            <span className={`text-xs px-2 py-1 rounded ${contact.status === 'established'
                              ? 'bg-green-800 text-green-200'
                              : contact.status === 'handshake_sent'
                                ? 'bg-yellow-800 text-yellow-200'
                                : 'bg-gray-700 text-gray-300'
                              }`}>
                              {contact.status === 'established'
                                ? 'connected'
                                : contact.status === 'handshake_sent'
                                  ? 'request sent'
                                  : contact.status.replace('_', ' ')}
                            </span>
                          </div>
                          {contact.lastMessage && (
                            <p className="text-xs text-gray-400 mt-1">
                              "{contact.lastMessage.slice(0, 30)}..."
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Right Panel - Conversation */}
                  <div className="lg:col-span-2 border border-gray-800 bg-gray-800/40 rounded-lg p-4 flex flex-col h-full">
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
                                <div className="flex items-center gap-2">
                                  <div className="animate-spin w-3 h-3 border border-gray-400 border-t-transparent rounded-full"></div>
                                  <span>Loading...</span>
                                  {syncProgress && <span>({syncProgress.current}/{syncProgress.total})</span>}
                                </div>
                              ) : (
                                "Load More History"
                              )}
                            </button>
                          </div>
                        )}

                        {/* Messages */}
                        <div className="flex-1 overflow-y-auto space-y-2 mb-4">
                          {messages
                            .filter(m => {
                              // without address o selectedContact, do not show messagges
                              const currentAddress = address || baseAddress;
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
                                className={`p-2 rounded max-w-xs ${msg.direction === 'outgoing'
                                  ? 'bg-blue-600 ml-auto'
                                  : msg.direction === 'incoming'
                                    ? 'bg-gray-700'
                                    : 'bg-gray-700 mx-auto text-center text-xs'
                                  }`}
                              >
                                <p className="text-sm flex items-center gap-1 overflow-visible">
                                  {msg.type === "system" && (
                                    msg.verified ? (
                                      <span className="relative group inline-flex items-center">
                                        <Fingerprint size={14} className="text-green-400 shrink-0" />
                                        <span
                                          role="tooltip"
                                          className="pointer-events-none absolute -top-2 left-20 -translate-x-1/2
                     px-2 py-1 text-xs rounded bg-gray-900 text-blue-100
                     border border-gray-700 opacity-0 group-hover:opacity-100
                     transition-opacity whitespace-nowrap z-50"
                                        >
                                          Identity proof verified
                                        </span>
                                      </span>
                                    ) : (
                                      msg.direction === "incoming" && (
                                        <span className="relative group inline-flex items-center">
                                          <X size={14} className="text-red-500 shrink-0" />
                                          <span
                                            role="tooltip"
                                            className="pointer-events-none absolute -top-7 left-20 -translate-x-1/2
                       px-2 py-1 text-xs rounded bg-gray-900 text-red-100
                       border border-gray-700 opacity-0 group-hover:opacity-100
                       transition-opacity whitespace-nowrap z-50"
                                          >
                                            Identity proof not verified
                                          </span>
                                        </span>
                                      )
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
                            const currentAddress = address || baseAddress;
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
                        <p>Network: Base</p>
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