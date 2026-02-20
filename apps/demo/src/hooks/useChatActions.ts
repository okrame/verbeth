// src/hooks/useChatActions.ts
// CLEANED VERSION - uses VerbethClient for all session creation

/**
 * Chat Actions Hook.
 * 
 * Provides high-level chat actions:
 * - sendHandshake / acceptHandshake
 * - sendMessageToContact
 * - Retry/cancel failed messages
 * - Queue status management
 * 
 * Uses VerbethClient for session creation.
 */

import { useCallback, useRef } from "react";
import { hexlify } from "ethers";
import type { VerbethClient } from "@verbeth/sdk";
import { dbService } from "../services/DbService.js";
import {
  Contact,
  generateTempMessageId,
} from "../types.js";
import { useMessageQueue } from "./useMessageQueue.js";

interface UseChatActionsProps {
  verbethClient: VerbethClient | null;
  readProvider: any;
  updateContact: (contact: Contact) => Promise<void>;
  addMessage: (message: any) => Promise<void>;
  updateMessageStatus: (id: string, status: "pending" | "confirmed" | "failed", error?: string) => Promise<void>;
  removeMessage: (id: string) => Promise<void>;
  removePendingHandshake: (id: string) => Promise<void>;
  setSelectedContact: (contact: Contact | null) => void;
  setLoading: (loading: boolean) => void;
  setMessage: (message: string) => void;
  setRecipientAddress: (address: string) => void;
  markMessagesLost: (contactAddress: string, afterTimestamp: number) => Promise<number>;
}

export const useChatActions = ({
  verbethClient,
  readProvider,
  updateContact,
  addMessage,
  updateMessageStatus,
  removeMessage,
  removePendingHandshake,
  setSelectedContact,
  setLoading,
  setMessage,
  setRecipientAddress,
  markMessagesLost,
}: UseChatActionsProps) => {

  const {
    queueMessage,
    retryMessage,
    cancelMessage,
    getQueueStatus,
    invalidateSessionCache,
    clearAllQueues,
  } = useMessageQueue({
    verbethClient,
    addMessage,
    updateMessageStatus,
    removeMessage,
    updateContact,
  });

  // Guard against duplicate acceptHandshake calls (e.g., rapid double-click)
  const acceptingHandshakesRef = useRef<Set<string>>(new Set());

  // ===========================================================================
  // Handshake Operations
  // ===========================================================================

  /**
   * Send a handshake to initiate contact.
   * Stores ephemeral secret and KEM secret for ratchet session init when response arrives.
   */
  const sendHandshake = useCallback(
    async (recipientAddress: string, message: string) => {
      if (!verbethClient) return;
      if (!recipientAddress || !message) return;

      setLoading(true);
      try {
        const { tx, ephemeralKeyPair, kemKeyPair } = await verbethClient.sendHandshake(
          recipientAddress,
          message
        );

        const newContact: Contact = {
          address: recipientAddress,
          ownerAddress: verbethClient.userAddress,
          status: "handshake_sent",
          handshakeEphemeralSecret: hexlify(ephemeralKeyPair.secretKey),
          handshakeKemSecret: hexlify(kemKeyPair.secretKey),
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

        setMessage("");
        setRecipientAddress("");
      } catch (error) {
        console.error("[verbeth] handshake failed:", error);
      } finally {
        setLoading(false);
      }
    },
    [
      verbethClient,
      updateContact,
      addMessage,
      setSelectedContact,
      setLoading,
      setMessage,
      setRecipientAddress,
    ]
  );

  /**
   * Accept a handshake from another user.
   * Creates ratchet session using VerbethClient and establishes contact.
   * Supports PQ-hybrid: if initiator includes KEM, kemSharedSecret is derived.
   */
  const acceptHandshake = useCallback(
    async (handshake: any, responseMessage: string) => {
      // Prevent duplicate calls for same handshake
      if (acceptingHandshakesRef.current.has(handshake.id)) {
        return;
      }
      acceptingHandshakesRef.current.add(handshake.id);

      if (!verbethClient) {
        acceptingHandshakesRef.current.delete(handshake.id);
        return;
      }

      try {
        // Use full ephemeral key (may include KEM public key)
        const ephemeralKey = handshake.ephemeralPubKeyFull || handshake.ephemeralPubKey;

        const {
          salt,
          responderEphemeralSecret,
          responderEphemeralPublic,
          kemSharedSecret,
        } = await verbethClient.acceptHandshake(
          ephemeralKey,
          responseMessage
        );

        // Create session using VerbethClient (handles topic derivation and hybrid KDF)
        const ratchetSession = verbethClient.createResponderSession({
          contactAddress: handshake.sender,
          responderEphemeralSecret,
          responderEphemeralPublic,
          initiatorEphemeralPubKey: ephemeralKey,
          salt,
          kemSharedSecret,
        });

        // Save session - SDK will pick it up via SessionStore adapter
        await dbService.ratchet.saveRatchetSession(ratchetSession);

        let establishedBlock: number | undefined;
        try {
          establishedBlock = Number(await readProvider.getBlockNumber());
        } catch {
          // Provider temporarily unavailable so no false dismissals.
        }

        const newContact: Contact = {
          address: handshake.sender,
          ownerAddress: verbethClient.userAddress,
          status: "established",
          identityPubKey: handshake.identityPubKey,
          signingPubKey: handshake.signingPubKey,
          topicOutbound: ratchetSession.currentTopicOutbound,
          topicInbound: ratchetSession.currentTopicInbound,
          conversationId: ratchetSession.conversationId,
          establishedAtBlock: establishedBlock,
          lastMessage: responseMessage,
          lastTimestamp: Date.now(),
        };

        await updateContact(newContact);

        // Mark messages as lost if this is a session reset
        if (handshake.isExistingContact && handshake.timestamp) {
          const lostCount = await markMessagesLost(handshake.sender, handshake.timestamp);
          if (lostCount > 0) {
            console.log(`${lostCount} messages marked as lost`);
          }
        }

        await removePendingHandshake(handshake.id);
        setSelectedContact(newContact);

        const acceptanceMessage = {
          id: generateTempMessageId(),
          topic: ratchetSession.currentTopicOutbound,
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
      } catch (error) {
        console.error("[verbeth] accept handshake failed:", error);
      } finally {
        acceptingHandshakesRef.current.delete(handshake.id);
      }
    },
    [
      verbethClient,
      readProvider,
      updateContact,
      removePendingHandshake,
      addMessage,
      setSelectedContact,
      markMessagesLost,
    ]
  );

  // ===========================================================================
  // Message Operations
  // ===========================================================================

  /**
   * Send a message to a contact.
   * Uses the message queue for sequential processing.
   */
  const sendMessageToContact = useCallback(
    async (contact: Contact, messageText: string) => {
      if (!verbethClient || !contact.conversationId) return;

      const messageId = await queueMessage(contact, messageText);
      
      if (messageId) {
        setMessage("");
      }
    },
    [verbethClient, queueMessage, setMessage]
  );

  /**
   * Retry a failed message.
   * Note: The message number will be different from the original attempt.
   */
  const retryFailedMessage = useCallback(
    async (messageId: string) => {
      await retryMessage(messageId);
    },
    [retryMessage]
  );

  /**
   * Cancel a queued message.
   */
  const cancelQueuedMessage = useCallback(
    async (messageId: string) => {
      await cancelMessage(messageId);
    },
    [cancelMessage]
  );

  /**
   * Get the queue status for a contact.
   */
  const getContactQueueStatus = useCallback(
    (contact: Contact) => {
      if (!contact.conversationId) {
        return { queueLength: 0, isProcessing: false, pendingMessages: [] };
      }
      return getQueueStatus(contact.conversationId);
    },
    [getQueueStatus]
  );

  /**
   * Invalidate session cache for a contact.
   * Call this when a session is reset or updated externally.
   */
  const invalidateContactSessionCache = useCallback(
    (contact: Contact) => {
      if (contact.conversationId) {
        invalidateSessionCache(contact.conversationId);
      }
    },
    [invalidateSessionCache]
  );

  return {
    sendHandshake,
    acceptHandshake,
    sendMessageToContact,
    // Queue-related actions
    retryFailedMessage,
    cancelQueuedMessage,
    getContactQueueStatus,
    invalidateContactSessionCache,
    clearAllQueues,
  };
};