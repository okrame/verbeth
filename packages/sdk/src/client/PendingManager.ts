// packages/sdk/src/client/PendingManager.ts

/**
 * Internal Pending Message Coordinator.
 * 
 * Manages the lifecycle of outbound messages:
 * - Creating pending records before tx submission
 * - Updating status on submission
 * - Matching confirmations by txHash
 * - Cleaning up after confirmation or failure
 */

import { PendingStore, PendingMessage, PendingStatus } from './types.js';

/**
 * Parameters for creating a new pending message.
 */
export interface CreatePendingParams {
  id: string;
  conversationId: string;
  topic: string;
  payloadHex: string;
  plaintext: string;
  sessionStateBefore: string;
  sessionStateAfter: string;
  createdAt: number;
}

/**
 * Internal pending message manager that wraps a PendingStore.
 */
export class PendingManager {
  constructor(private store: PendingStore) {}

  /**
   * Create and save a pending message record.
   * Called right before submitting a transaction.
   */
  async create(params: CreatePendingParams): Promise<PendingMessage> {
    const pending: PendingMessage = {
      ...params,
      txHash: null,
      status: 'preparing',
    };
    await this.store.save(pending);
    return pending;
  }

  /**
   * Mark as submitted with transaction hash.
   * Called immediately after tx is broadcast.
   */
  async markSubmitted(id: string, txHash: string): Promise<void> {
    await this.store.updateStatus(id, 'submitted', txHash);
  }

  /**
   * Mark as failed.
   * Called when tx submission fails.
   * Note: Ratchet slot is already burned (session was committed).
   */
  async markFailed(id: string): Promise<void> {
    await this.store.updateStatus(id, 'failed');
  }


  async get(id: string): Promise<PendingMessage | null> {
    return this.store.get(id);
  }


  async getByTxHash(txHash: string): Promise<PendingMessage | null> {
    return this.store.getByTxHash(txHash);
  }

  async getByConversation(conversationId: string): Promise<PendingMessage[]> {
    return this.store.getByConversation(conversationId);
  }


  /**
   * Finalize (confirm) and delete.
   * Called when we see our MessageSent event on-chain.
   * 
   * @returns The finalized pending message, or null if not found
   */
  async finalize(id: string): Promise<PendingMessage | null> {
    const pending = await this.store.get(id);
    if (!pending) {
      return null;
    }
    
    await this.store.delete(id);
    return pending;
  }

  /**
   * Delete a pending message without finalizing.
   * Used for cleanup on failure or cancellation.
   */
  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }

  /**
   * Clean up stale pending messages.
   * Called periodically to remove old failed/stuck records.
   * 
   * @param conversationId - Conversation to clean up
   * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
   * @returns Number of records cleaned up
   */
  async cleanupStale(
    conversationId: string,
    maxAgeMs: number = 24 * 60 * 60 * 1000
  ): Promise<number> {
    const pending = await this.store.getByConversation(conversationId);
    const cutoff = Date.now() - maxAgeMs;
    
    let cleaned = 0;
    for (const p of pending) {
      if (p.createdAt < cutoff) {
        await this.store.delete(p.id);
        cleaned++;
      }
    }
    
    return cleaned;
  }
}