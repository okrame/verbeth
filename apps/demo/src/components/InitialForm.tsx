import { ConnectButton } from '@rainbow-me/rainbowkit';

interface CenteredHandshakeFormProps {
  isConnected: boolean;
  isBaseConnected: boolean;
  loading: boolean;
  recipientAddress: string;
  setRecipientAddress: (address: string) => void;
  message: string;
  setMessage: (message: string) => void;
  onSendHandshake: () => void;
  contactsLength: number;
  onBackToChats?: () => void;
  onConnectBase: () => Promise<void>;
  hasExistingIdentity: boolean;
}

export function InitialForm({
  isConnected,
  isBaseConnected,
  loading,
  recipientAddress,
  setRecipientAddress,
  message,
  setMessage,
  onSendHandshake,
  contactsLength,
  onBackToChats,
  onConnectBase,
  hasExistingIdentity
}: CenteredHandshakeFormProps) {
  const isAnyConnected = isConnected || isBaseConnected;
  const shouldShowConnect =
    !isAnyConnected && (recipientAddress.trim().length > 0 || message.trim().length > 0);

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="border border-gray-800 rounded-lg p-8 w-full max-w-md">
        <div className="flex items-center justify-between mb-6">
          {contactsLength > 0 ? (
            <>
              <div>
                <h2 className="text-2xl font-semibold text-left">
                  New Chat
                </h2>
              </div>
              <button
                onClick={onBackToChats}
                className="text-sm text-gray-400 hover:text-white flex items-center gap-1 transition-colors"
              >
                ← Back to chats
              </button>
            </>
          ) : (
            <div className="w-full text-center">
              <h2 className="text-2xl font-semibold">
                {isAnyConnected ? "Hey, " : ""}Have Your First Say
              </h2>
              <div className="mt-2">
                <span className="text-sm text-gray-400">
                  Uncensorable. Private by design.
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <input
            type="text"
            placeholder="Recipient address (0x...)"
            value={recipientAddress}
            onChange={(e) => setRecipientAddress(e.target.value)}
            className="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded text-white"
          />
          <input
            type="text"
            placeholder="Your message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded text-white"
          />
          {shouldShowConnect ? (
            <button
              onClick={onConnectBase} // ← Cambia da openConnectModal a onConnectBase
              className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 rounded font-medium"
            >
              {hasExistingIdentity ? "Sign In" : "Get started"}
            </button>
          ) : (
            <button
              onClick={onSendHandshake}
              disabled={loading || !recipientAddress.trim() || !message.trim() || !isAnyConnected}
              className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium"
            >
              {loading ? "Sending..." : "Send Request"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
