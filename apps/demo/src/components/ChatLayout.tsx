import { type ReactNode, useState } from "react";
import { Fingerprint, RotateCcw, X, ArrowLeft } from "lucide-react";
import type { Contact, Message, PendingHandshake, SyncProgress } from "../types.js";
import { CatchUpBanner } from "./CatchUpBanner.js";
import { HistoryScanner } from "./HistoryScanner.js";
import { PinnedResetRequest } from "./PinnedResetRequest.js";

interface ChatLayoutProps {
  contacts: Contact[];
  selectedContact: Contact | null;
  setSelectedContact: (contact: Contact | null) => void;
  messages: Message[];
  address: string | undefined;
  hasPendingReset: boolean;
  pendingResetHandshake: PendingHandshake | null | undefined;
  limboAfterTimestamp: number | null | undefined;
  acceptHandshake: (handshake: PendingHandshake, message: string) => void;
  queueStatus: { queueLength: number; isProcessing: boolean } | null;
  loading: boolean;
  sendMessageToContact: (contact: Contact, message: string) => void;
  retryFailedMessage: (id: string) => void;
  cancelQueuedMessage: (id: string) => void;
  setShowHandshakeForm: (show: boolean) => void;
  syncProgress: SyncProgress | null;
  canLoadMore: boolean;
  isLoadingMore: boolean;
  backfillCooldown: boolean;
  oldestScannedBlock: number | null;
  oldestScannedDate: Date | null;
  loadMoreHistory: () => void;
}

export function ChatLayout({
  contacts,
  selectedContact,
  setSelectedContact,
  messages,
  address,
  hasPendingReset,
  pendingResetHandshake,
  limboAfterTimestamp,
  acceptHandshake,
  queueStatus,
  loading,
  sendMessageToContact,
  retryFailedMessage,
  cancelQueuedMessage,
  setShowHandshakeForm,
  syncProgress,
  canLoadMore,
  isLoadingMore,
  backfillCooldown,
  oldestScannedBlock,
  oldestScannedDate,
  loadMoreHistory,
}: ChatLayoutProps) {
  const [mobilePanelView, setMobilePanelView] = useState<'contacts' | 'chat'>('contacts');

  const handleSelectContact = (contact: Contact) => {
    setSelectedContact(contact);
    setMobilePanelView('chat');
  };

  const renderMessage = (msg: Message) => {
    const isOutgoing = msg.direction === 'outgoing';
    const isFailed = msg.status === 'failed';
    const isPending = msg.status === 'pending';
    const isLost = msg.isLost === true;
    const isInLimbo = !isLost && hasPendingReset && isOutgoing && msg.type !== 'system' && limboAfterTimestamp && msg.timestamp > limboAfterTimestamp;

    const isSystem = msg.type === 'system';
    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const statusIcon = isOutgoing
      ? (isLost ? '✗' :
        isInLimbo ? '✓' :
          msg.status === 'confirmed' ? '✓✓' :
            msg.status === 'failed' ? '✗' :
              msg.status === 'pending' ? '✓' : '?')
      : null;

    return (
      <div
        key={msg.id}
        className={`max-w-[80%] w-fit ${isOutgoing ? 'ml-auto' : ''}`}
      >
        <div
          className={`px-2.5 py-1.5 rounded-lg ${isOutgoing
            ? isFailed
              ? 'bg-red-900/50 border border-red-700'
              : 'bg-blue-600'
            : 'bg-gray-700'
            } ${isSystem ? 'bg-gray-800 text-gray-400 italic' : ''}
           ${isPending || isInLimbo || isLost ? 'opacity-60' : ''}`}
        >
          <p className="text-sm leading-relaxed">
            {isSystem && msg.verified !== undefined && (
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

            {isSystem && msg.decrypted ? (
              <>
                <span className="font-bold">{msg.decrypted.split(":")[0]}:</span>
                {msg.decrypted.split(":").slice(1).join(":")}
              </>
            ) : (
              msg.decrypted || msg.ciphertext
            )}

            {/* Invisible spacer to reserve room for the inline timestamp */}
            {!isSystem && (
              <span className="invisible text-[11px] pl-2">
                {timeStr}{isOutgoing ? ' ✓✓' : ''}
              </span>
            )}
          </p>

          {/* Inline timestamp pulled up to sit on the last text line */}
          {!isSystem ? (
            <span className="float-right -mt-[16px] flex items-center gap-1 text-[11px] text-gray-300/80 leading-none pl-3">
              {timeStr}
              {statusIcon && (
                <span title={isLost ? 'Undelivered' : `Status: ${msg.status}`} className={statusIcon === '✓✓' ? 'tracking-[-4px]' : ''}>
                  {statusIcon}
                </span>
              )}
            </span>
          ) : (
            <div className="flex justify-end items-center gap-1 mt-0.5">
              <span className="text-[11px] text-gray-500">
                {timeStr}
              </span>
            </div>
          )}
        </div>

        {/* Failed message actions */}
        {isFailed && isOutgoing && (
          <div className="flex items-center justify-end gap-2 mt-1 text-xs">
            <span className="text-red-400">Failed to send</span>
            <button
              onClick={() => retryFailedMessage(msg.id)}
              className="flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors"
              title="Send again"
            >
              <RotateCcw size={12} />
              <span>Retry</span>
            </button>
            <button
              onClick={() => cancelQueuedMessage(msg.id)}
              className="flex items-center gap-1 text-gray-400 hover:text-gray-300 transition-colors"
              title="Delete message"
            >
              <X size={12} />
              <span>Delete</span>
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-3 gap-0 lg:gap-4">
      {/* Left Panel - Contacts */}
      <div
        className={`${
          mobilePanelView === 'contacts' ? 'flex' : 'hidden'
        } lg:flex flex-col border border-gray-800 bg-gray-800/30 rounded-lg p-4 min-h-0`}
      >
        <div className="flex justify-between items-center mb-4 shrink-0">
          <h2 className="text-lg font-semibold">Contacts</h2>
          <button
            onClick={() => setShowHandshakeForm(true)}
            className="text-sm text-blue-400 hover:text-blue-300"
          >
            + New
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto space-y-2 custom-scrollbar">
          {contacts.map((contact) => (
            <div
              key={contact.address}
              onClick={() => handleSelectContact(contact)}
              className={`p-3 rounded cursor-pointer transition-colors ${
                selectedContact?.address === contact.address
                  ? 'bg-gray-700'
                  : 'bg-gray-800 hover:bg-gray-750'
              }`}
            >
              <div className="flex justify-between items-start">
                <span className="font-mono text-sm">
                  {contact.address.slice(0, 8)}...{contact.address.slice(-6)}
                </span>
                <span className={`text-xs px-2 py-1 rounded ${
                  contact.status === 'established'
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
        <div className="shrink-0">
          <HistoryScanner
            canLoadMore={canLoadMore}
            isLoadingMore={isLoadingMore}
            backfillCooldown={backfillCooldown}
            syncProgress={syncProgress}
            oldestScannedBlock={oldestScannedBlock}
            oldestScannedDate={oldestScannedDate}
            onLoadMore={loadMoreHistory}
          />
        </div>
      </div>

      {/* Right Panel - Conversation */}
      <div
        className={`${
          mobilePanelView === 'chat' ? 'flex' : 'hidden'
        } lg:flex lg:col-span-2 flex-col border border-gray-800 bg-gray-800/40 rounded-lg p-4 min-h-0`}
      >
        {/* Chat header */}
        <div className="flex items-center gap-3 mb-4 shrink-0">
          <button
            onClick={() => setMobilePanelView('contacts')}
            className="lg:hidden p-1 -ml-1 text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <h2 className="text-lg font-semibold">
            {selectedContact ? `Chat with ${selectedContact.address.slice(0, 8)}...` : 'Select a contact'}
          </h2>
        </div>

        <CatchUpBanner syncProgress={syncProgress} />

        {selectedContact ? (
          <>
            {/* Messages */}
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col-reverse gap-2 mb-4 pr-2 custom-scrollbar">
              {(() => {
                const contactMessages = messages
                  .filter(m => {
                    if (!address || !selectedContact?.address) return false;
                    return (
                      m.sender.toLowerCase() === selectedContact.address.toLowerCase() ||
                      (m.direction === 'outgoing' && m.recipient?.toLowerCase() === selectedContact.address.toLowerCase()) ||
                      (selectedContact.topicOutbound && m.topic === selectedContact.topicOutbound) ||
                      (selectedContact.topicInbound && m.topic === selectedContact.topicInbound)
                    );
                  })
                  .sort((a, b) => a.timestamp - b.timestamp);

                const formatDayLabel = (ts: number): string => {
                  const d = new Date(ts);
                  const now = new Date();
                  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
                  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
                  if (day === today) return 'Today';
                  if (day === today - 86400000) return 'Yesterday';
                  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
                };

                return contactMessages.length > 0
                  ? contactMessages.flatMap((msg, i) => {
                      const dayLabel = formatDayLabel(msg.timestamp);
                      const prevDay = i > 0 ? formatDayLabel(contactMessages[i - 1].timestamp) : null;
                      const elements: ReactNode[] = [];
                      if (dayLabel !== prevDay) {
                        elements.push(
                          <div key={`day-${dayLabel}`} className="flex items-center gap-3 my-3">
                            <div className="flex-1 border-t border-gray-700" />
                            <span className="text-xs text-gray-500 whitespace-nowrap">{dayLabel}</span>
                            <div className="flex-1 border-t border-gray-700" />
                          </div>
                        );
                      }
                      elements.push(renderMessage(msg));
                      return elements;
                    }).slice().reverse()
                  : !hasPendingReset && (
                      <p className="text-gray-400 text-sm text-center py-8">
                        No messages yet. {selectedContact.status === 'established' ? 'Start the conversation!' : 'Waiting for handshake completion.'}
                      </p>
                    );
              })()}

              {hasPendingReset && pendingResetHandshake && (
                <PinnedResetRequest
                  handshake={pendingResetHandshake}
                  onAccept={acceptHandshake}
                />
              )}
            </div>

            {/* Queue Status Indicator */}
            {queueStatus && queueStatus.queueLength > 0 && (
              <div className="flex items-center gap-2 px-3 py-2 mb-2 bg-yellow-900/30 border border-yellow-800 rounded text-xs text-yellow-300 shrink-0">
                {queueStatus.isProcessing ? (
                  <>
                    <span className="animate-spin w-3 h-3 border border-yellow-400 border-t-transparent rounded-full"></span>
                    <span>Sending {queueStatus.queueLength} message{queueStatus.queueLength > 1 ? 's' : ''}...</span>
                  </>
                ) : (
                  <>
                    <span>📨</span>
                    <span>{queueStatus.queueLength} message{queueStatus.queueLength > 1 ? 's' : ''} queued</span>
                  </>
                )}
              </div>
            )}

            {/* Message Input */}
            {selectedContact.status === 'established' && selectedContact.identityPubKey && (
              <div className="flex gap-2 shrink-0">
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
              <div className="text-center py-4 text-gray-400 text-sm shrink-0">
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
  );
}
