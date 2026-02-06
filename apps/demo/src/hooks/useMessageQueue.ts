// src/hooks/useMessageQueue.ts

/**
 * Message Queue Hook for Sequential Processing with Optimistic UI.
 *
 * Uses VerbethClient's two-phase commit pattern:
 * 1. prepareMessage() - get ID and encrypted payload
 * 2. Submit tx manually
 * 3. confirmTx() on chain confirmation
 *
 * The key insight: we use prepareMessage()'s ID for BOTH the optimistic
 * message AND the pending record, so confirmTx() can find the right message.
 */

import { useCallback, useRef, useEffect } from "react";
import { hexlify } from "ethers";
import type { VerbethClient } from "@verbeth/sdk";
import { Contact, Message } from "../types.js";
import { dbService } from "../services/DbService.js";


export type QueuedMessageStatus = 
  | "queued"     // In queue, waiting to be sent
  | "sending"    // Currently being encrypted/submitted
  | "pending"    // Submitted, awaiting confirmation
  | "confirmed"  // Confirmed on-chain
  | "failed";    // Failed to send

export interface QueuedMessage {
  id: string;
  conversationId: string;
  contact: Contact;
  plaintext: string;
  status: QueuedMessageStatus;
  error?: string;
  txHash?: string;
  createdAt: number;
}

interface ConversationQueue {
  messages: QueuedMessage[];
  isProcessing: boolean;
}

interface UseMessageQueueProps {
  verbethClient: VerbethClient | null;
  addMessage: (message: Message) => Promise<void>;
  updateMessageStatus: (id: string, status: Message["status"], error?: string) => Promise<void>;
  removeMessage: (id: string) => Promise<void>;
  updateContact: (contact: Contact) => Promise<void>;
}


export const useMessageQueue = ({
  verbethClient,
  addMessage,
  updateMessageStatus,
  removeMessage,
  updateContact,
}: UseMessageQueueProps) => {

  const queuesRef = useRef<Map<string, ConversationQueue>>(new Map());
  const failedMessagesRef = useRef<Map<string, QueuedMessage>>(new Map());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ===========================================================================
  // Queue Processor - Uses prepareMessage() for ID-first approach
  // ===========================================================================

  const processQueue = useCallback(async (conversationId: string) => {
    if (!verbethClient || !mountedRef.current) return;

    const queue = queuesRef.current.get(conversationId);
    if (!queue || queue.isProcessing || queue.messages.length === 0) return;

    queue.isProcessing = true;

    while (queue.messages.length > 0 && mountedRef.current) {
      const queuedMsg = queue.messages[0];
      
      // Skip already processed messages
      if (queuedMsg.status === "confirmed" || queuedMsg.status === "pending") {
        queue.messages.shift();
        continue;
      }

      if (queuedMsg.status === "failed") {
        queue.messages.shift();
        continue;
      }

      // Track prepared ID for error handling (survives into catch block)
      let preparedId: string | null = null;

      try {
        queuedMsg.status = "sending";

        // =====================================================================
        // Step 1: Prepare message - this gives us the ID and encrypted payload
        // Session is committed immediately for forward secrecy
        // =====================================================================
        const prepared = await verbethClient.prepareMessage(
          conversationId,
          queuedMsg.plaintext
        );

        // Update queuedMsg.id IMMEDIATELY so catch block has correct ID
        preparedId = prepared.id;
        queuedMsg.id = prepared.id;

        // =====================================================================
        // Step 2: Create optimistic message with the SAME ID as prepared
        // This is the key fix - both share prepared.id
        // =====================================================================
        const optimisticMessage: Message = {
          id: prepared.id,
          topic: prepared.topic,
          sender: verbethClient.userAddress,
          recipient: queuedMsg.contact.address,
          ciphertext: "",
          timestamp: prepared.createdAt,
          blockTimestamp: prepared.createdAt,
          blockNumber: 0,
          direction: "outgoing",
          decrypted: queuedMsg.plaintext,
          read: true,
          nonce: prepared.messageNumber,
          dedupKey: `pending-${prepared.id}`,
          type: "text",
          ownerAddress: verbethClient.userAddress,
          status: "pending",
        };

        await addMessage(optimisticMessage);

        // =====================================================================
        // Step 3: Create pending record (SDK's PendingStore via StorageAdapter)
        // =====================================================================
        await dbService.savePendingOutbound({
          id: prepared.id,
          conversationId,
          topic: prepared.topic,
          payloadHex: hexlify(prepared.payload),
          plaintext: queuedMsg.plaintext,
          sessionStateBefore: JSON.stringify({ epoch: prepared.sessionBefore.topicEpoch }),
          sessionStateAfter: JSON.stringify({ epoch: prepared.sessionAfter.topicEpoch }),
          createdAt: prepared.createdAt,
          txHash: null,
          status: 'preparing',
        });

        // =====================================================================
        // Step 4: Submit transaction
        // =====================================================================
        const timestamp = Math.floor(Date.now() / 1000);
        const tx = await verbethClient.executorInstance.sendMessage(
          prepared.payload,
          prepared.topic,
          timestamp,
          BigInt(prepared.messageNumber)
        );

        // =====================================================================
        // Step 5: Update pending with txHash
        // =====================================================================
        await dbService.updatePendingOutboundStatus(prepared.id, 'submitted', tx.hash);

        queuedMsg.txHash = tx.hash;
        queuedMsg.status = "pending";

        // Update contact with current topic (may have ratcheted)
        const session = await verbethClient.getSession(conversationId);
        if (session) {
          const updatedContact: Contact = {
            ...queuedMsg.contact,
            topicOutbound: session.currentTopicOutbound,
            topicInbound: session.currentTopicInbound,
            lastMessage: queuedMsg.plaintext,
            lastTimestamp: Date.now(),
          };
          await updateContact(updatedContact);
        }

        queue.messages.shift();

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        queuedMsg.status = "failed";
        queuedMsg.error = errorMessage;

        // Use preparedId if message was already created in DB, otherwise use original queue id
        const messageId = preparedId ?? queuedMsg.id;

        // Note: Ratchet slot may already be burned (session was committed in prepareMessage)
        await updateMessageStatus(messageId, "failed", errorMessage);

        console.error(`[verbeth] send failed: ${errorMessage}`);

        // Store failed message for retry/cancel (use correct ID)
        queuedMsg.id = messageId;
        failedMessagesRef.current.set(messageId, { ...queuedMsg });

        // Remove from active queue
        queue.messages.shift();
      }
    }

    queue.isProcessing = false;
  }, [verbethClient, addMessage, updateContact, updateMessageStatus]);


  /**
   * Queue a message for sending.
   */
  const queueMessage = useCallback(async (
    contact: Contact,
    messageText: string
  ): Promise<string | null> => {
    if (!verbethClient || !contact.conversationId) return null;

    const conversationId = contact.conversationId;
    
    // Use a temporary ID for queue tracking only (will be replaced with prepared.id)
    const tempId = `queue-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // Create queued message (optimistic UI created later with correct ID)
    const queuedMessage: QueuedMessage = {
      id: tempId,
      conversationId,
      contact,
      plaintext: messageText,
      status: "queued",
      createdAt: Date.now(),
    };

    // Get or create queue for this conversation
    let queue = queuesRef.current.get(conversationId);
    if (!queue) {
      queue = { messages: [], isProcessing: false };
      queuesRef.current.set(conversationId, queue);
    }

    queue.messages.push(queuedMessage);
    console.log(`[verbeth] message queued (temp ID: ${tempId}) for conversation ${conversationId}`);

    // Trigger queue processing (non-blocking)
    setTimeout(() => processQueue(conversationId), 0);

    return tempId;
  }, [verbethClient, processQueue]);

  const retryMessage = useCallback(async (messageId: string): Promise<boolean> => {
    const failedMessage = failedMessagesRef.current.get(messageId);
    
    if (failedMessage) {
      const conversationId = failedMessage.conversationId;
      
      failedMessagesRef.current.delete(messageId);
      await removeMessage(messageId);
      
      // Reset status for retry (will get new ID in processQueue)
      failedMessage.id = `queue-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      failedMessage.status = "queued";
      failedMessage.error = undefined;
      failedMessage.createdAt = Date.now();
      
      let queue = queuesRef.current.get(conversationId);
      if (!queue) {
        queue = { messages: [], isProcessing: false };
        queuesRef.current.set(conversationId, queue);
      }
      
      // Add to end of queue
      queue.messages.push(failedMessage);

      console.log(`[verbeth] retrying message (temp ID: ${failedMessage.id}) for conversation ${conversationId}`);
      
      // Trigger processing
      setTimeout(() => processQueue(conversationId), 0);
      
      return true;
    }

    return false;
  }, [removeMessage, processQueue]);

  /**
   * Cancel/delete a failed or queued message.
   */
  const cancelMessage = useCallback(async (messageId: string): Promise<boolean> => {
    // Check failed messages map first
    const failedMessage = failedMessagesRef.current.get(messageId);
    
    if (failedMessage) {
      failedMessagesRef.current.delete(messageId);
      
      await removeMessage(messageId);
      return true;
    }

    // Fallback: check active queues
    for (const [, queue] of queuesRef.current.entries()) {
      const messageIndex = queue.messages.findIndex(
        m => m.id === messageId && (m.status === "queued" || m.status === "failed")
      );
      
      if (messageIndex !== -1) {
        const message = queue.messages[messageIndex];
        queue.messages.splice(messageIndex, 1);
        
        await removeMessage(messageId);
        return true;
      }
    }
    
    return false;
  }, [removeMessage]);

  /**
   * Get queue status for a conversation.
   */
  const getQueueStatus = useCallback((conversationId: string): {
    queueLength: number;
    isProcessing: boolean;
    pendingMessages: QueuedMessage[];
  } => {
    const queue = queuesRef.current.get(conversationId);
    if (!queue) {
      return { queueLength: 0, isProcessing: false, pendingMessages: [] };
    }
    return {
      queueLength: queue.messages.length,
      isProcessing: queue.isProcessing,
      pendingMessages: [...queue.messages],
    };
  }, []);

  /**
   * Invalidate cached session for a conversation.
   */
  const invalidateSessionCache = useCallback((conversationId: string) => {
    verbethClient?.invalidateSessionCache(conversationId);
  }, [verbethClient]);

  /**
   * Clear all queues (e.g., on logout).
   */
  const clearAllQueues = useCallback(() => {
    queuesRef.current.clear();
    failedMessagesRef.current.clear();
    verbethClient?.clearSessionCache();
  }, [verbethClient]);

  return {
    queueMessage,
    retryMessage,
    cancelMessage,
    getQueueStatus,
    invalidateSessionCache,
    clearAllQueues,
  };
};