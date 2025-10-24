import { useCallback } from "react";
import {
  pickOutboundTopic,
  VerbethClient
} from "@verbeth/sdk";
import { Contact, generateTempMessageId } from "../types.js";

interface UseChatActionsProps {
  verbethClient: VerbethClient | null; 
  addLog: (message: string) => void;
  updateContact: (contact: Contact) => Promise<void>;
  addMessage: (message: any) => Promise<void>;
  removePendingHandshake: (id: string) => Promise<void>;
  setSelectedContact: (contact: Contact | null) => void;
  setLoading: (loading: boolean) => void;
  setMessage: (message: string) => void;
  setRecipientAddress: (address: string) => void;
}

export const useChatActions = ({
  verbethClient,
  addLog,
  updateContact,
  addMessage,
  removePendingHandshake,
  setSelectedContact,
  setLoading,
  setMessage,
  setRecipientAddress,
}: UseChatActionsProps) => {

  const sendHandshake = useCallback(
    async (recipientAddress: string, message: string) => {
      if (!verbethClient) {
        addLog("✗ Client not initialized");
        return;
      }

      if (!recipientAddress || !message) {
        addLog("✗ Missing recipient address or message");
        return;
      }

      setLoading(true);
      try {
        const { tx, ephemeralKeyPair } = await verbethClient.sendHandshake(
          recipientAddress,
          message
        );

        const newContact: Contact = {
          address: recipientAddress,
          ownerAddress: verbethClient.userAddress,
          status: "handshake_sent",
          ephemeralKey: ephemeralKeyPair.secretKey, 
          lastMessage: message,
          lastTimestamp: Date.now(),
        };

        await updateContact(newContact);
        setSelectedContact(newContact);

        const handshakeMessage = {
          id: generateTempMessageId(),
          topic: "",
          sender: verbethClient.userAddress,
          recipient: recipientAddress,
          ciphertext: "",
          timestamp: Date.now(),
          blockTimestamp: Date.now(),
          blockNumber: 0,
          direction: "outgoing" as const,
          decrypted: `Request sent: "${message}"`,
          read: true,
          nonce: 0,
          dedupKey: `handshake-${tx.hash}`,
          type: "system" as const,
          ownerAddress: verbethClient.userAddress,
          status: "pending" as const,
        };

        await addMessage(handshakeMessage);

        addLog(
          `Handshake sent to ${recipientAddress.slice(0, 8)}...: "${message}" (tx: ${tx.hash})`
        );
        setMessage("");
        setRecipientAddress("");
      } catch (error) {
        console.error("Failed to send handshake:", error);
        addLog(
          `✗ Failed to send handshake: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      } finally {
        setLoading(false);
      }
    },
    [
      verbethClient, 
      addLog,
      updateContact,
      addMessage,
      setSelectedContact,
      setLoading,
      setMessage,
      setRecipientAddress,
    ]
  );

  const acceptHandshake = useCallback(
    async (handshake: any, responseMessage: string) => {
      if (!verbethClient) {
        addLog("✗ Client not initialized");
        return;
      }

      try {
        const { tx, duplexTopics } = await verbethClient.acceptHandshake(
          handshake.ephemeralPubKey,
          handshake.identityPubKey,
          responseMessage
        );

        // Client auto-derived topics, just use them!
        const newContact: Contact = {
          address: handshake.sender,
          ownerAddress: verbethClient.userAddress,
          status: "established",
          identityPubKey: handshake.identityPubKey,
          signingPubKey: handshake.signingPubKey,
          topicOutbound: pickOutboundTopic(false, duplexTopics), // Responder
          topicInbound: pickOutboundTopic(true, duplexTopics),   // Responder
          lastMessage: responseMessage,
          lastTimestamp: Date.now(),
        };

        await updateContact(newContact);
        await removePendingHandshake(handshake.id);
        setSelectedContact(newContact);

        const acceptanceMessage = {
          id: generateTempMessageId(),
          topic: duplexTopics.topicOut,
          sender: verbethClient.userAddress,
          recipient: handshake.sender,
          ciphertext: "",
          timestamp: Date.now(),
          blockTimestamp: Date.now(),
          blockNumber: 0,
          direction: "outgoing" as const,
          decrypted: `Request accepted: "${responseMessage}"`,
          read: true,
          nonce: 0,
          dedupKey: `handshake-accepted-${handshake.id}`,
          type: "system" as const,
          ownerAddress: verbethClient.userAddress,
          status: "pending" as const,
        };

        await addMessage(acceptanceMessage);

        addLog(
          `✅ Handshake accepted from ${handshake.sender.slice(
            0,
            8
          )}...: "${responseMessage}"`
        );
      } catch (error) {
        console.error("Failed to accept handshake:", error);
        addLog(
          `✗ Failed to accept handshake: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    },
    [
      verbethClient, 
      addLog,
      updateContact,
      removePendingHandshake,
      addMessage,
      setSelectedContact,
    ]
  );

  const sendMessageToContact = useCallback(
    async (contact: Contact, messageText: string) => {
      if (!verbethClient) {
        addLog("✗ Client not initialized");
        return;
      }

      if (!contact.identityPubKey) {
        addLog("✗ Contact not established or missing identity key");
        return;
      }

      setLoading(true);
      try {
        if (!contact.topicOutbound) {
          addLog("✗ Contact doesn't have outbound topic established");
          return;
        }

        await verbethClient.sendMessage(
          contact.topicOutbound,
          contact.identityPubKey,
          messageText
        );

        // Create pending message for UI
        const pendingMessage = {
          id: generateTempMessageId(),
          topic: contact.topicOutbound,
          sender: verbethClient.userAddress,
          recipient: contact.address,
          ciphertext: "",
          timestamp: Date.now(),
          blockTimestamp: Date.now(),
          blockNumber: 0,
          direction: "outgoing" as const,
          decrypted: messageText,
          read: true,
          nonce: 0,
          dedupKey: `pending-${generateTempMessageId()}`,
          type: "text" as const,
          ownerAddress: verbethClient.userAddress,
          status: "pending" as const,
        };

        await addMessage(pendingMessage);

        const updatedContact: Contact = {
          ...contact,
          lastMessage: messageText,
          lastTimestamp: Date.now(),
        };
        await updateContact(updatedContact);

        addLog(
          `Message sent to ${contact.address.slice(0, 8)}...: "${messageText}"`
        );
      } catch (error) {
        console.error("Failed to send message:", error);
        addLog(
          `✗ Failed to send message: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      } finally {
        setLoading(false);
      }
    },
    [
      verbethClient, 
      addLog,
      addMessage,
      updateContact,
      setLoading,
    ]
  );

  return {
    sendHandshake,
    acceptHandshake,
    sendMessageToContact,
  };
};
