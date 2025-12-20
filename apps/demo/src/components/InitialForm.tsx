import { useConnectModal } from '@rainbow-me/rainbowkit';
import { motion } from 'framer-motion';

interface CenteredHandshakeFormProps {
  isConnected: boolean;
  loading: boolean;
  recipientAddress: string;
  setRecipientAddress: (address: string) => void;
  message: string;
  setMessage: (message: string) => void;
  onSendHandshake: () => void;
  contactsLength: number;
  onBackToChats?: () => void;
  hasExistingIdentity: boolean;
}

export function InitialForm({
  isConnected,
  loading,
  recipientAddress,
  setRecipientAddress,
  message,
  setMessage,
  onSendHandshake,
  contactsLength,
  onBackToChats,
  hasExistingIdentity
}: CenteredHandshakeFormProps) {
  const { openConnectModal } = useConnectModal();
  
  const isAnyConnected = isConnected;
  const shouldShowConnect =
    !isAnyConnected && (recipientAddress.trim().length > 0 || message.trim().length > 0);

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <motion.div
        className="border border-gray-800 rounded-lg p-8 w-full max-w-md"
        animate={{
          boxShadow: [
            `0 0 5px rgba(209, 213, 219, 0.25),
       0 0 10px rgba(209, 213, 219, 0.18),
       0 0 15px rgba(209, 213, 219, 0.12),
       inset 0 0 5px rgba(209, 213, 219, 0.1)`,

            `0 0 6px rgba(209, 213, 219, 0.32),
       0 0 12px rgba(209, 213, 219, 0.52),
       0 0 18px rgba(209, 213, 219, 0.15),
       inset 0 0 6px rgba(209, 213, 219, 0.12)`,

            `0 0 5px rgba(209, 213, 219, 0.25),
       0 0 10px rgba(209, 213, 219, 0.18),
       0 0 15px rgba(209, 213, 219, 0.12),
       inset 0 0 5px rgba(209, 213, 219, 0.1)`
          ]
        }}
        transition={{
          duration: 4,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      >
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
                {isAnyConnected ? "Hi, start your first chat" : "just verb it"}
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
              onClick={openConnectModal}
              className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 rounded font-medium"
            >
              {hasExistingIdentity ? "Connect Wallet" : "Get started"}
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
      </motion.div>
    </div>
  );
}