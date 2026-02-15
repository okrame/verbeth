// src/services/StorageAdapters.ts

/**
 * Storage Adapters for VerbethClient SDK.
 * 
 * These adapters implement the SDK's SessionStore and PendingStore interfaces,
 * connecting the VerbethClient to the app's IndexedDB persistence layer.
 * 
 * Usage:
 * ```typescript
 * import { configureClientStorage } from './StorageAdapters';
 * 
 * const client = new VerbethClient(config);
 * configureClientStorage(client);
 * ```
 */

import type { 
  SessionStore, 
  PendingStore, 
  PendingMessage, 
  PendingStatus,
  RatchetSession,
} from '@verbeth/sdk';
import { dbService } from './DbService.js';
import type { PendingOutbound } from '../types.js';

// =============================================================================
// Session Store Adapter
// =============================================================================

/**
 * Adapts DbService to the SDK's SessionStore interface.
 * Handles session persistence with automatic topic lookup.
 */
class SessionStoreAdapter implements SessionStore {
  /**
   * Get session by conversation ID (primary key).
   */
  async get(conversationId: string): Promise<RatchetSession | null> {
    return dbService.ratchet.getRatchetSessionByConversation(conversationId);
  }

  /**
   * Find session by any active inbound topic.
   * Checks current, next, and previous (within grace period) topics.
   */
  async getByInboundTopic(topic: string): Promise<RatchetSession | null> {
    return dbService.ratchet.getRatchetSessionByAnyInboundTopic(topic);
  }

  /**
   * Persist session state.
   */
  async save(session: RatchetSession): Promise<void> {
    return dbService.ratchet.saveRatchetSession(session);
  }
}

// =============================================================================
// Pending Store Adapter
// =============================================================================

/**
 * Adapts DbService to the SDK's PendingStore interface.
 * Handles pending outbound message lifecycle.
 */
class PendingStoreAdapter implements PendingStore {
  /**
   * Save a new pending message.
   */
  async save(pending: PendingMessage): Promise<void> {
    const dbPending: PendingOutbound = {
      id: pending.id,
      conversationId: pending.conversationId,
      topic: pending.topic,
      payloadHex: pending.payloadHex,
      plaintext: pending.plaintext,
      sessionStateBefore: pending.sessionStateBefore,
      sessionStateAfter: pending.sessionStateAfter,
      createdAt: pending.createdAt,
      txHash: pending.txHash,
      status: pending.status,
    };
    return dbService.ratchet.savePendingOutbound(dbPending);
  }

  /**
   * Get pending message by ID.
   */
  async get(id: string): Promise<PendingMessage | null> {
    const pending = await dbService.ratchet.getPendingOutbound(id);
    return pending ? this.toPendingMessage(pending) : null;
  }

  /**
   * Get pending message by transaction hash.
   */
  async getByTxHash(txHash: string): Promise<PendingMessage | null> {
    const pending = await dbService.ratchet.getPendingOutboundByTxHash(txHash);
    return pending ? this.toPendingMessage(pending) : null;
  }

  /**
   * Update pending message status.
   */
  async updateStatus(id: string, status: PendingStatus, txHash?: string): Promise<void> {
    return dbService.ratchet.updatePendingOutboundStatus(id, status, txHash);
  }

  /**
   * Delete pending message.
   */
  async delete(id: string): Promise<void> {
    return dbService.ratchet.deletePendingOutbound(id);
  }

  /**
   * Get all pending messages for a conversation.
   */
  async getByConversation(conversationId: string): Promise<PendingMessage[]> {
    const pending = await dbService.ratchet.getPendingOutboundByConversation(conversationId);
    return pending.map(p => this.toPendingMessage(p));
  }

  /**
   * Convert DB format to SDK format.
   */
  private toPendingMessage(pending: PendingOutbound): PendingMessage {
    return {
      id: pending.id,
      conversationId: pending.conversationId,
      topic: pending.topic,
      payloadHex: pending.payloadHex,
      plaintext: pending.plaintext,
      sessionStateBefore: pending.sessionStateBefore,
      sessionStateAfter: pending.sessionStateAfter,
      createdAt: pending.createdAt,
      txHash: pending.txHash,
      status: pending.status as PendingStatus,
    };
  }
}

// =============================================================================
// Singleton Instances (exported for createVerbethClient factory)
// =============================================================================

export const sessionStore = new SessionStoreAdapter();
export const pendingStore = new PendingStoreAdapter();