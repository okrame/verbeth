import { useEffect, useState } from "react";
import { useAccount, useWalletClient } from 'wagmi';
import { RpcProvider, useRpcClients } from './rpc.js';
import {
  VerbethClient,
  createVerbethClient,
} from '@verbeth/sdk';
import { useMessageListener } from './hooks/useMessageListener.js';
import { useMessageProcessor } from './hooks/useMessageProcessor.js';
import {
  VERBETH_SINGLETON_ADDR,
  Contact,
} from './types.js';
import { InitialForm } from './components/InitialForm.js';
import { IdentityCreation } from './components/IdentityCreation.js';
import { ChatLayout } from "./components/ChatLayout.js";
import { SessionSetupPrompt } from './components/SessionSetupPrompt.js';
import { WalletButton } from './components/WalletButton.js';
import { WalletPanel } from './components/WalletPanel.js';
import { useChatActions } from './hooks/useChatActions.js';
import { useSessionSetup } from './hooks/useSessionSetup.js';
import { useInitIdentity } from './hooks/useInitIdentity.js';
import { usePendingSessionReset } from './hooks/usePendingSessionReset.js';
import { sessionStore, pendingStore } from './services/StorageAdapters.js';
import { APP_CHAIN_ID, isSupportedChain } from './chain.js';

export default function App() {
  const { chainId: walletChainId, isConnected } = useAccount();
  const activeChainId = (isConnected && walletChainId && isSupportedChain(walletChainId))
    ? walletChainId
    : APP_CHAIN_ID;

  return (
    <RpcProvider chainId={activeChainId}>
      <AppContent chainId={activeChainId} />
    </RpcProvider>
  );
}

function AppContent({ chainId }: { chainId: number }) {
  const { ethers: readProvider, viem: viemClient, transportStatus } = useRpcClients();
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [ready, setReady] = useState(false);
  const [recipientAddress, setRecipientAddress] = useState("");
  const [message, setMessage] = useState("");
  const [selectedContactAddress, setSelectedContactAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showHandshakeForm, setShowHandshakeForm] = useState(true);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [verbethClient, setVerbethClient] = useState<VerbethClient | null>(null);

  const {
    identityKeyPair,
    identityProof,
    executor,
    identitySigner,
    safeAddr,
    needsIdentityCreation,
    identityContext,
    // Session state
    sessionSignerAddr,
    needsSessionSetup,
    isSafeDeployed,
    isModuleEnabled,
    setIsSafeDeployed,
    setIsModuleEnabled,
    setNeedsSessionSetup,
    signingStep,
    // Actions
    needsModeSelection,
    fastModeAvailable,
    fastModeUnavailableReason,
    executionMode,
    emitterAddress,
    createIdentity,
  } = useInitIdentity({
    walletClient,
    address,
    chainId,
    readProvider,
    ready,
    onIdentityCreated: () => {},
    onReset: () => {
      setSelectedContactAddress(null);
      setVerbethClient(null);
    },
  });

  // useSessionSetup receives state from useInitIdentity
  const {
    sessionSignerBalance,
    refreshSessionBalance,
    setupSession,
  } = useSessionSetup({
    walletClient,
    address,
    safeAddr,
    sessionSignerAddr,
    chainId,
    readProvider,
    isSafeDeployed,
    isModuleEnabled,
    setIsSafeDeployed,
    setIsModuleEnabled,
    setNeedsSessionSetup,
    executionMode,
  });

  // ===========================================================================
  // Create VerbethClient with storage adapters using factory function
  // ===========================================================================
  useEffect(() => {
    const currentAddress = address;

    if (executor && identityKeyPair && identityProof && identitySigner && currentAddress) {
      const client = createVerbethClient({
        address: currentAddress,
        signer: identitySigner,
        identityKeyPair,
        identityProof,
        executor,
        sessionStore,
        pendingStore,
      });

      setVerbethClient(client);
    } else {
      setVerbethClient(null);
    }
  }, [executor, identityKeyPair, identityProof, identitySigner, address]);

  const {
    messages,
    pendingHandshakes,
    contacts,
    addMessage,
    updateMessageStatus,
    removeMessage,
    removePendingHandshake,
    updateContact,
    processEvents,
    markMessagesLost
  } = useMessageProcessor({
    readProvider,
    identityContext,
    address: address ?? undefined,
    emitterAddress: emitterAddress ?? undefined,
    identityKeyPair,
    verbethClient,
  });

  const selectedContact = contacts.find(
    (c) => c.address.toLowerCase() === selectedContactAddress?.toLowerCase()
  ) ?? null;
  const setSelectedContact = (contact: Contact | null) =>
    setSelectedContactAddress(contact?.address ?? null);

  const { hasPendingReset, pendingHandshake: pendingResetHandshake, limboAfterTimestamp } =
    usePendingSessionReset(selectedContact, pendingHandshakes);

  const {
    isInitialLoading,
    isLoadingMore,
    canLoadMore,
    syncProgress,
    loadMoreHistory,
    oldestScannedBlock,
    oldestScannedDate,
    backfillCooldown,
  } = useMessageListener({
    readProvider,
    address: address ?? undefined,
    emitterAddress: emitterAddress ?? undefined,
    onEventsProcessed: processEvents,
    viemClient,
    verbethClient,
    chainId,
  });

  const {
    sendHandshake,
    acceptHandshake,
    sendMessageToContact,
    retryFailedMessage,
    cancelQueuedMessage,
    getContactQueueStatus,
  } = useChatActions({
    verbethClient,
    readProvider,
    updateContact: async (contact: Contact) => { await updateContact(contact); },
    addMessage: async (message: any) => { await addMessage(message); },
    updateMessageStatus,
    removeMessage,
    removePendingHandshake: async (id: string) => { await removePendingHandshake(id); },
    setSelectedContact,
    setLoading,
    setMessage,
    setRecipientAddress,
    markMessagesLost,
  });

  const providerLabel = (() => {
    switch (transportStatus) {
      case "ws":
        return "WS + Public HTTP";
      case "http-public":
        return "Public HTTP";
      case "disconnected":
        return "Disconnected";
    }
  })();

  useEffect(() => {
    setReady(readProvider !== null && isConnected && walletClient !== undefined);
  }, [readProvider, isConnected, walletClient]);

  // hide handshake form when we have contacts AND user is connected
  useEffect(() => {
    const currentlyConnected = isConnected;
    setShowHandshakeForm(!ready || !currentlyConnected || contacts.length === 0 || needsIdentityCreation);
  }, [ready, isConnected, contacts.length, needsIdentityCreation]);

  // Get queue status for selected contact
  const queueStatus = selectedContact ? getContactQueueStatus(selectedContact) : null;

  return (
    <div className="h-dvh bg-black text-white flex flex-col overflow-hidden">
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
      <div className="w-full bg-black relative shrink-0">
        <div className="flex justify-between items-start px-2 sm:px-4 py-2 sm:py-4">
          {/* LEFT: title */}
          <div className="flex flex-col items-start">
            <h1 className="text-2xl sm:text-4xl font-extrabold leading-tight">
              Demo chat
            </h1>
            <div className="text-xs text-gray-400 pl-0.5 mt-1">
              powered by Verbeth
            </div>
          </div>
          {/* RIGHT: wallet button */}
          <WalletButton
            pendingCount={pendingHandshakes.length}
            isPanelOpen={isPanelOpen}
            onTogglePanel={() => setIsPanelOpen(v => !v)}
          />
        </div>
      </div>

      {/* Wallet Panel */}
      <WalletPanel
        isOpen={isPanelOpen}
        onClose={() => setIsPanelOpen(false)}
        identityKeyPair={identityKeyPair}
        executionMode={executionMode}
        sessionSignerAddr={sessionSignerAddr}
        sessionSignerBalance={sessionSignerBalance}
        pendingHandshakes={pendingHandshakes}
        onAcceptHandshake={acceptHandshake}
        onRejectHandshake={removePendingHandshake}
        safeAddr={safeAddr}
        canLoadMore={canLoadMore}
        isLoadingMore={isLoadingMore}
        backfillCooldown={backfillCooldown}
        syncProgress={syncProgress}
        oldestScannedBlock={oldestScannedBlock}
        oldestScannedDate={oldestScannedDate}
        onLoadMore={loadMoreHistory}
      />

      {/* Main content with max-width */}
      <div className="max-w-6xl mx-auto w-full pt-px px-2 sm:px-4 pb-2 flex-1 min-h-0 overflow-hidden flex flex-col">
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 flex flex-col">

            {/* Session Setup Prompt - show when wallet connected but session not ready */}
            {isConnected && sessionSignerAddr && !needsIdentityCreation && (needsSessionSetup || (sessionSignerBalance !== null && sessionSignerBalance < BigInt(0.0001 * 1e18))) && (
              <SessionSetupPrompt
                sessionSignerAddr={sessionSignerAddr}
                sessionSignerBalance={sessionSignerBalance}
                needsSessionSetup={needsSessionSetup}
                isSafeDeployed={isSafeDeployed}
                isModuleEnabled={isModuleEnabled}
                onSetupSession={setupSession}
                onRefreshBalance={refreshSessionBalance}
                loading={loading}
              />
            )}

            {(needsIdentityCreation || needsModeSelection) ? (
              <IdentityCreation
                loading={loading}
                onCreateIdentity={createIdentity}
                address={address ?? ''}
                signingStep={signingStep}
                needsModeSelection={needsModeSelection}
                fastModeAvailable={fastModeAvailable}
                fastModeUnavailableReason={fastModeUnavailableReason}
                chainId={chainId}
              />
            ) : showHandshakeForm ? (
              <>
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
              </>
            ) : (
              <ChatLayout
                contacts={contacts}
                selectedContact={selectedContact}
                setSelectedContact={setSelectedContact}
                messages={messages}
                address={address}
                hasPendingReset={hasPendingReset}
                pendingResetHandshake={pendingResetHandshake}
                limboAfterTimestamp={limboAfterTimestamp}
                acceptHandshake={acceptHandshake}
                queueStatus={queueStatus}
                loading={loading}
                sendMessageToContact={sendMessageToContact}
                retryFailedMessage={retryFailedMessage}
                cancelQueuedMessage={cancelQueuedMessage}
                setShowHandshakeForm={setShowHandshakeForm}
                syncProgress={syncProgress}
                canLoadMore={canLoadMore}
                isLoadingMore={isLoadingMore}
                backfillCooldown={backfillCooldown}
                oldestScannedBlock={oldestScannedBlock}
                oldestScannedDate={oldestScannedDate}
                loadMoreHistory={loadMoreHistory}
              />
            )}
          </div>
        </div>
      </div>

      {ready && (
        <div className="shrink-0 border-t border-gray-900 bg-black p-2 sm:p-3 text-xs text-gray-500 space-y-1">
          <p>Contract: {VERBETH_SINGLETON_ADDR}</p>
          <p>Network: {chainId} · {providerLabel}</p>
          <p>Status: {(isInitialLoading || isLoadingMore) ? '🟡 Loading' : '🟢 Ready'}
            {syncProgress?.failedChunks ? ` · ${syncProgress.failedChunks} chunk${syncProgress.failedChunks > 1 ? 's' : ''} in retry` : ''}
          </p>
        </div>
      )}
    </div>
  );
}
