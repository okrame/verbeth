// src/hooks/useMessageQueue.ts

/**
 * Message Queue Hook for Sequential Processing with Optimistic UI.
 * 
 * 1. Session state is cached per conversation and persists across processQueue calls
 * 2. After encryption, session state is immediately saved to DB (not waiting for confirmation)
 * 3. Failed messages don't corrupt session state - the ratchet slot is "burned"
 * 4. Confirmations now just clean up pending records, not commit session state
 * 
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
  removeMessage: (id: string) => Promise<void>;
  updateContact: (contact: Contact) => Promise<void>;
}


export const useMessageQueue = ({
  verbethClient,
  addLog,
  addMessage,
  updateMessageStatus,
  removeMessage,
  updateContact,
}: UseMessageQueueProps) => {

  const queuesRef = useRef<Map<string, ConversationQueue>>(new Map());
  
  // persistent session cache across processQueue invocations
  // This ensures we never lose track of the latest session state
  const sessionCacheRef = useRef<Map<string, RatchetSession>>(new Map());
  
  const failedMessagesRef = useRef<Map<string, QueuedMessage>>(new Map());
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

    queue.isProcessing = true;

    // Check session cache first, only fall back to DB if not cached
    // This ensures we always use the most recently advanced session state
    let currentSession: RatchetSession | null = sessionCacheRef.current.get(conversationId) ?? null;
    
    if (!currentSession) {
      try {
        currentSession = await dbService.getRatchetSessionByConversation(conversationId);
        if (currentSession) {
          sessionCacheRef.current.set(conversationId, currentSession);
          addLog(`📂 Loaded session from DB for ${conversationId.slice(0, 10)}...`);
        }
      } catch (error) {
        addLog(`✗ Failed to load ratchet session for ${conversationId.slice(0, 10)}...`);
        queue.isProcessing = false;
        return;
      }
    }

    if (!currentSession) {
      addLog(`✗ No ratchet session found for ${conversationId.slice(0, 10)}...`);
      queue.isProcessing = false;
      return;
    }

    while (queue.messages.length > 0 && mountedRef.current) {
      const message = queue.messages[0];
      
      if (message.status === "confirmed" || message.status === "pending") {
        queue.messages.shift();
        continue;
      }

      if (message.status === "failed") {
        queue.messages.shift();
        continue;
      }

      try {
        message.status = "sending";
        
        // use the cached in-memory session state
        const sessionBefore = currentSession;

        const plaintext = new TextEncoder().encode(message.plaintext);
        const { session: nextSession, header, ciphertext, signature } = ratchetEncrypt(
          sessionBefore,
          plaintext,
          verbethClient.identityKeyPairInstance.signingSecretKey
        );

        // =====================================================================
        // Update BOTH in-memory cache AND DB immediately after encryption
        // I.e., we commit the session state BEFORE sending the tx
        // 
        // Why this is safe:
        // 1. If tx succeeds: receiver gets message, session states are in sync
        // 2. If tx fails: the ratchet "slot" is burned, but receiver's skip-key
        //    mechanism will handle the gap when they receive subsequent messages
        // 3. This matches how Signal handles message failures
        // =====================================================================
        currentSession = nextSession;
        sessionCacheRef.current.set(conversationId, nextSession);
        
        await dbService.saveRatchetSession(nextSession);
        addLog(`💾 Session state committed (sendingMsgNumber=${nextSession.sendingMsgNumber})`);

        // Package binary payload
        const payload = packageRatchetPayload(signature, header, ciphertext);
        const payloadHex = hexlify(payload);

        // Create pending record for confirmation matching (simplified - no session state)
        const pending: PendingOutbound = {
          id: message.id,
          conversationId,
          topic: sessionBefore.topicOutbound,
          payloadHex,
          plaintext: message.plaintext,
          sessionStateBefore: JSON.stringify(serializeRatchetSession(sessionBefore)),
          sessionStateAfter: JSON.stringify(serializeRatchetSession(nextSession)),
          createdAt: message.createdAt,
          txHash: null,
          status: "preparing",
        };
        await dbService.savePendingOutbound(pending);

        // Send transaction
        const timestamp = Math.floor(Date.now() / 1000);
        const nonce = nextSession.sendingMsgNumber - 1; // The message number we just used

        await dbService.updatePendingOutboundStatus(message.id, "submitted");

        const tx = await verbethClient.executorInstance.sendMessage(
          payload,
          sessionBefore.topicOutbound,
          timestamp,
          BigInt(nonce)
        );

        // Update with txHash
        message.txHash = tx.hash;
        message.status = "pending";
        await dbService.updatePendingOutboundStatus(message.id, "submitted", tx.hash);

        addLog(`📤 Message sent: "${message.plaintext.slice(0, 30)}..." (tx: ${tx.hash.slice(0, 10)}..., n=${nonce})`);

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

        // =====================================================================
        // On failure, we do NOT roll back session state
        // The ratchet slot is "burned" - the encryption already advanced the
        // chain. If we rolled back, we'd reuse the same key which is a security
        // violation. Instead, we let the slot be skipped - the receiver will
        // handle this via their skip-key mechanism.
        //
        // This is intentional and matches Signal's behavior.
        // =====================================================================

        
        try {
          await dbService.deletePendingOutbound(message.id);
        } catch {
        }

        await updateMessageStatus(message.id, "failed", errorMessage);

        addLog(`✗ Failed to send (slot burned): "${message.plaintext.slice(0, 20)}..." - ${errorMessage}`);

        // Store failed message for retry/cancel
        failedMessagesRef.current.set(message.id, { ...message });

        // Remove from active queue
        queue.messages.shift();

        // Continue processing remaining messages with the advanced session state
        // (currentSession is already updated, which is correct)
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

    // Create queued message
    const queuedMessage: QueuedMessage = {
      id: messageId,
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

    // Add to queue
    queue.messages.push(queuedMessage);

    // Show optimistic UI message immediately
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

    // Trigger queue processing (non-blocking)
    setTimeout(() => processQueue(conversationId), 0);

    return messageId;
  }, [verbethClient, addLog, addMessage, processQueue]);

  /**
   * Retry a failed message.
   * 
   * IMPORTANT: The original ratchet slot was burned. Retry creates a NEW
   * encryption with the current (advanced) session state. This means the
   * message number will be different from the original attempt.
   */
  const retryMessage = useCallback(async (messageId: string): Promise<boolean> => {
    // Check the failed messages map first
    const failedMessage = failedMessagesRef.current.get(messageId);
    
    if (failedMessage) {
      const conversationId = failedMessage.conversationId;
      
      // Remove from failed messages map
      failedMessagesRef.current.delete(messageId);
      
      // Reset status for retry
      failedMessage.status = "queued";
      failedMessage.error = undefined;
      failedMessage.createdAt = Date.now();
      
      // Get or create queue
      let queue = queuesRef.current.get(conversationId);
      if (!queue) {
        queue = { messages: [], isProcessing: false };
        queuesRef.current.set(conversationId, queue);
      }
      
      // Add to end of queue
      queue.messages.push(failedMessage);
      
      // Update UI status back to pending
      await updateMessageStatus(messageId, "pending");
      
      addLog(`🔄 Retrying message (new slot): "${failedMessage.plaintext.slice(0, 30)}..."`);
      
      // Trigger processing
      setTimeout(() => processQueue(conversationId), 0);
      
      return true;
    }
    
    // Fallback: check if still in active queue (shouldn't happen normally)
    for (const [conversationId, queue] of queuesRef.current.entries()) {
      const messageIndex = queue.messages.findIndex(
        m => m.id === messageId && m.status === "failed"
      );
      
      if (messageIndex !== -1) {
        const message = queue.messages[messageIndex];
        
        message.status = "queued";
        message.error = undefined;
        message.createdAt = Date.now();

        // Move to end of queue
        queue.messages.splice(messageIndex, 1);
        queue.messages.push(message);

        await updateMessageStatus(messageId, "pending");
        
        addLog(`🔄 Retrying message: "${message.plaintext.slice(0, 30)}..."`);

        setTimeout(() => processQueue(conversationId), 0);
        
        return true;
      }
    }

    addLog(`✗ Could not find message ${messageId} to retry`);
    return false;
  }, [addLog, updateMessageStatus, processQueue]);

  /**
   * Cancel/delete a failed or queued message.
   */
  const cancelMessage = useCallback(async (messageId: string): Promise<boolean> => {
    // Check failed messages map first
    const failedMessage = failedMessagesRef.current.get(messageId);
    
    if (failedMessage) {
      failedMessagesRef.current.delete(messageId);
      
      // Remove from DB and UI
      await removeMessage(messageId);
      
      addLog(`🗑️ Deleted message: "${failedMessage.plaintext.slice(0, 30)}..."`);
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
        
        addLog(`🗑️ Deleted message: "${message.plaintext.slice(0, 30)}..."`);
        return true;
      }
    }
    
    addLog(`✗ Could not find message ${messageId} to delete`);
    return false;
  }, [addLog, removeMessage]);

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
   * Call this when session is reset or updated externally.
   */
  const invalidateSessionCache = useCallback((conversationId: string) => {
    sessionCacheRef.current.delete(conversationId);
    addLog(`🔄 Session cache invalidated for ${conversationId.slice(0, 10)}...`);
  }, [addLog]);

  /**
   * Clear all queues (e.g., on logout).
   */
  const clearAllQueues = useCallback(() => {
    queuesRef.current.clear();
    failedMessagesRef.current.clear();
    sessionCacheRef.current.clear();
  }, []);

  return {
    queueMessage,
    retryMessage,
    cancelMessage,
    getQueueStatus,
    invalidateSessionCache,
    clearAllQueues,
  };
};