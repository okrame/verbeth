// src/hooks/useMessageQueue.ts

/**
 * Message Queue Hook for Sequential Processing with Optimistic UI.
 * 
 * Solves the race condition problem by:
 * 1. Immediately showing messages in UI (optimistic)
 * 2. Queuing messages per conversation
 * 3. Processing queue sequentially in background
 * 4. Handling failures with retry capability
 */

import { useCallback, useRef, useEffect } from "react";
import { hexlify } from "ethers";
import {
  VerbethClient,
  ratchetEncrypt,
  packageRatchetPayload,
  RatchetSession,
} from "@verbeth/sdk";
import { dbService } from "../services/DbService.js";
import {
  Contact,
  Message,
  PendingOutbound,
  generateTempMessageId,
  serializeRatchetSession,
} from "../types.js";

// =============================================================================
// Types
// =============================================================================

export type QueuedMessageStatus = 
  | "queued"      // In queue, waiting for previous to complete
  | "sending"     // Currently being sent
  | "pending"     // Tx submitted, waiting for confirmation
  | "confirmed"   // On-chain confirmed
  | "failed";     // Failed, can retry

export interface QueuedMessage {
  id: string;
  conversationId: string;
  contact: Contact;
  plaintext: string;
  status: QueuedMessageStatus;
  error?: string;
  txHash?: string;
  createdAt: number;
  // Pre-computed encryption (computed when message reaches front of queue)
  encryptedPayload?: Uint8Array;
  sessionStateAfter?: string;
}

interface ConversationQueue {
  messages: QueuedMessage[];
  isProcessing: boolean;
}

interface UseMessageQueueProps {
  verbethClient: VerbethClient | null;
  addLog: (message: string) => void;
  addMessage: (message: Message) => Promise<void>;
  updateMessageStatus: (id: string, status: Message["status"], error?: string) => Promise<void>;
  updateContact: (contact: Contact) => Promise<void>;
}

// =============================================================================
// Hook
// =============================================================================

export const useMessageQueue = ({
  verbethClient,
  addLog,
  addMessage,
  updateMessageStatus,
  updateContact,
}: UseMessageQueueProps) => {
  // Queue per conversation
  const queuesRef = useRef<Map<string, ConversationQueue>>(new Map());
  
  // Track mounted state to prevent updates after unmount
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ===========================================================================
  // Queue Processor
  // ===========================================================================

  const processQueue = useCallback(async (conversationId: string) => {
    if (!verbethClient || !mountedRef.current) return;

    const queue = queuesRef.current.get(conversationId);
    if (!queue || queue.isProcessing || queue.messages.length === 0) return;

    // Mark as processing
    queue.isProcessing = true;

    while (queue.messages.length > 0 && mountedRef.current) {
      const message = queue.messages[0];
      
      // Skip already processed messages
      if (message.status === "confirmed" || message.status === "pending") {
        queue.messages.shift();
        continue;
      }

      // Skip failed messages (user must explicitly retry)
      if (message.status === "failed") {
        queue.messages.shift();
        continue;
      }

      try {
        message.status = "sending";
        
        // 1. Load current session state
        const session = await dbService.getRatchetSessionByConversation(conversationId);
        if (!session) {
          throw new Error("No ratchet session found");
        }

        // 2. Encrypt with ratchet
        const plaintext = new TextEncoder().encode(message.plaintext);
        const { session: nextSession, header, ciphertext, signature } = ratchetEncrypt(
          session,
          plaintext,
          verbethClient.identityKeyPairInstance.signingSecretKey
        );

        // 3. Package binary payload
        const payload = packageRatchetPayload(signature, header, ciphertext);
        const payloadHex = hexlify(payload);

        // 4. Create pending record (two-phase commit)
        const pending: PendingOutbound = {
          id: message.id,
          conversationId,
          topic: session.topicOutbound,
          payloadHex,
          plaintext: message.plaintext,
          sessionStateBefore: JSON.stringify(serializeRatchetSession(session)),
          sessionStateAfter: JSON.stringify(serializeRatchetSession(nextSession)),
          createdAt: message.createdAt,
          txHash: null,
          status: "preparing",
        };
        await dbService.savePendingOutbound(pending);

        // 5. Send transaction
        const timestamp = Math.floor(Date.now() / 1000);
        const nonce = nextSession.sendingMsgNumber - 1;

        await dbService.updatePendingOutboundStatus(message.id, "submitted");

        const tx = await verbethClient.executorInstance.sendMessage(
          payload,
          session.topicOutbound,
          timestamp,
          BigInt(nonce)
        );

        // 6. Update with txHash
        message.txHash = tx.hash;
        message.status = "pending";
        await dbService.updatePendingOutboundStatus(message.id, "submitted", tx.hash);

        addLog(`📤 Message sent: "${message.plaintext.slice(0, 30)}..." (tx: ${tx.hash.slice(0, 10)}...)`);

        // Update contact
        const updatedContact: Contact = {
          ...message.contact,
          lastMessage: message.plaintext,
          lastTimestamp: Date.now(),
        };
        await updateContact(updatedContact);

        // Remove from queue (confirmation will be handled by useMessageProcessor)
        queue.messages.shift();

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        
        // Mark as failed
        message.status = "failed";
        message.error = errorMessage;

        // Rollback: delete pending record if it was created
        try {
          await dbService.deletePendingOutbound(message.id);
        } catch {
          // Ignore cleanup errors
        }

        // Update UI message status
        await updateMessageStatus(message.id, "failed", errorMessage);

        addLog(`✗ Failed to send: "${message.plaintext.slice(0, 20)}..." - ${errorMessage}`);

        // Remove failed message from queue (user can retry via UI)
        queue.messages.shift();

        // Don't break - continue processing remaining messages
        // (they might succeed if the failure was transient)
      }
    }

    queue.isProcessing = false;
  }, [verbethClient, addLog, updateContact, updateMessageStatus]);

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Queue a message for sending.
   * Shows optimistically in UI immediately, processes sequentially.
   */
  const queueMessage = useCallback(async (
    contact: Contact,
    messageText: string
  ): Promise<string | null> => {
    if (!verbethClient) {
      addLog("✗ Client not initialized");
      return null;
    }

    if (!contact.conversationId) {
      addLog("✗ Contact doesn't have a ratchet session");
      return null;
    }

    const messageId = generateTempMessageId();
    const conversationId = contact.conversationId;

    // 1. Create queued message
    const queuedMessage: QueuedMessage = {
      id: messageId,
      conversationId,
      contact,
      plaintext: messageText,
      status: "queued",
      createdAt: Date.now(),
    };

    // 2. Get or create queue for this conversation
    let queue = queuesRef.current.get(conversationId);
    if (!queue) {
      queue = { messages: [], isProcessing: false };
      queuesRef.current.set(conversationId, queue);
    }

    // 3. Add to queue
    queue.messages.push(queuedMessage);

    // 4. Show optimistic UI message immediately
    const optimisticMessage: Message = {
      id: messageId,
      topic: contact.topicOutbound || "",
      sender: verbethClient.userAddress,
      recipient: contact.address,
      ciphertext: "",
      timestamp: Date.now(),
      blockTimestamp: Date.now(),
      blockNumber: 0,
      direction: "outgoing",
      decrypted: messageText,
      read: true,
      nonce: 0,
      dedupKey: `pending-${messageId}`,
      type: "text",
      ownerAddress: verbethClient.userAddress,
      status: "pending",
    };

    await addMessage(optimisticMessage);

    addLog(`📝 Message queued: "${messageText.slice(0, 30)}..."`);

    // 5. Trigger queue processing (non-blocking)
    // Use setTimeout to ensure this runs after current execution
    setTimeout(() => processQueue(conversationId), 0);

    return messageId;
  }, [verbethClient, addLog, addMessage, processQueue]);

  /**
   * Retry a failed message.
   */
  const retryMessage = useCallback(async (messageId: string): Promise<boolean> => {
    // Find the message in any queue
    for (const [conversationId, queue] of queuesRef.current.entries()) {
      const messageIndex = queue.messages.findIndex(
        m => m.id === messageId && m.status === "failed"
      );
      
      if (messageIndex !== -1) {
        const message = queue.messages[messageIndex];
        
        // Reset status and re-add to queue
        message.status = "queued";
        message.error = undefined;
        message.createdAt = Date.now();

        // Move to end of queue
        queue.messages.splice(messageIndex, 1);
        queue.messages.push(message);

        // Update UI
        await updateMessageStatus(messageId, "pending");
        
        addLog(`🔄 Retrying message: "${message.plaintext.slice(0, 30)}..."`);

        // Trigger processing
        setTimeout(() => processQueue(conversationId), 0);
        
        return true;
      }
    }

    // Message not in queue - might need to reload from DB
    // For now, return false
    addLog(`✗ Could not find message ${messageId} to retry`);
    return false;
  }, [addLog, updateMessageStatus, processQueue]);

  /**
   * Cancel a queued (not yet sent) message.
   */
  const cancelMessage = useCallback(async (messageId: string): Promise<boolean> => {
    for (const [, queue] of queuesRef.current.entries()) {
      const messageIndex = queue.messages.findIndex(
        m => m.id === messageId && (m.status === "queued" || m.status === "failed")
      );
      
      if (messageIndex !== -1) {
        const message = queue.messages[messageIndex];
        queue.messages.splice(messageIndex, 1);
        
        // Remove from DB/UI
        await dbService.deleteMessage(messageId);
        
        addLog(`🗑️ Cancelled message: "${message.plaintext.slice(0, 30)}..."`);
        return true;
      }
    }
    
    return false;
  }, [addLog]);

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
   * Clear all queues (e.g., on logout).
   */
  const clearAllQueues = useCallback(() => {
    queuesRef.current.clear();
  }, []);

  return {
    queueMessage,
    retryMessage,
    cancelMessage,
    getQueueStatus,
    clearAllQueues,
  };
};