// packages/sdk/src/client/SessionManager.ts

/**
 * Internal Session Coordinator.
 * 
 * Handles:
 * - Session caching for performance
 * - Topic matching (current, next, previous)
 * - Automatic topic promotion when next topic is used
 * - Cache invalidation
 */

import { RatchetSession, TOPIC_TRANSITION_WINDOW_MS } from '../ratchet/types.js';
import { SessionStore } from './types.js';

export interface TopicLookupResult {
  session: RatchetSession;
  topicMatch: 'current' | 'next' | 'previous';
}

/**
 * Internal session manager that wraps a SessionStore with caching
 * and topic promotion logic.
 */
export class SessionManager {
  private cache = new Map<string, RatchetSession>();
  
  constructor(private store: SessionStore) {}

  // ===========================================================================
  // Session Retrieval
  // ===========================================================================

  /**
   * Get session by conversation ID, checking cache first.
   */
  async getByConversationId(conversationId: string): Promise<RatchetSession | null> {
    const cached = this.cache.get(conversationId);
    if (cached) {
      return cached;
    }

    const session = await this.store.get(conversationId);
    if (session) {
      this.cache.set(conversationId, session);
    }
    return session;
  }

  /**
   * Find session by inbound topic with automatic topic promotion.
   * 
   * Checks topics in order:
   * 1. currentTopicInbound - standard case
   * 2. nextTopicInbound - DH ratchet advanced, promotes topics
   * 3. previousTopicInbound - grace period for late messages
   * 
   * @param topic - The topic to look up
   * @returns Session and match type, or null if not found
   */
  async getByInboundTopic(topic: string): Promise<TopicLookupResult | null> {
    const topicLower = topic.toLowerCase();
    
    const session = await this.store.getByInboundTopic(topic);
    if (!session) {
      return null;
    }

    // Check cache for more recent state (e.g. for batched operations)
    const cached = this.cache.get(session.conversationId);
    let workingSession = cached || session;

    if (workingSession.currentTopicInbound.toLowerCase() === topicLower) {
      if (!cached) {
        this.cache.set(workingSession.conversationId, workingSession);
      }
      return { session: workingSession, topicMatch: 'current' };
    }

    if (workingSession.nextTopicInbound?.toLowerCase() === topicLower) {
      // Promote next topics to current
      workingSession = this.promoteTopics(workingSession);
      this.cache.set(workingSession.conversationId, workingSession);
      return { session: workingSession, topicMatch: 'next' };
    }

    if (
      workingSession.previousTopicInbound?.toLowerCase() === topicLower &&
      workingSession.previousTopicExpiry &&
      Date.now() < workingSession.previousTopicExpiry
    ) {
      if (!cached) {
        this.cache.set(workingSession.conversationId, workingSession);
      }
      return { session: workingSession, topicMatch: 'previous' };
    }

    // Topic found in store but doesn't match current session state (this shouldn't happen normally, but handle gracefully)
    return null;
  }

  // ===========================================================================
  // Session Persistence
  // ===========================================================================

  /**
   * Update session in cache and persist to store.
   */
  async save(session: RatchetSession): Promise<void> {
    this.cache.set(session.conversationId, session);
    await this.store.save(session);
  }

  /**
   * Update cache without persisting (for batch operations).
   */
  updateCache(session: RatchetSession): void {
    this.cache.set(session.conversationId, session);
  }

  /**
   * Persist all cached sessions to store.
   */
  async flushCache(): Promise<void> {
    const saves = Array.from(this.cache.values()).map(s => this.store.save(s));
    await Promise.all(saves);
  }

  // ===========================================================================
  // Cache Management
  // ===========================================================================

  /**
   * Invalidate cache entry (e.g., on session reset).
   */
  invalidate(conversationId: string): void {
    this.cache.delete(conversationId);
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  isCached(conversationId: string): boolean {
    return this.cache.has(conversationId);
  }

  /**
   * Promote next topics to current (internal helper).
   * Called when a message arrives on nextTopicInbound.
   */
  private promoteTopics(session: RatchetSession): RatchetSession {
    if (!session.nextTopicInbound || !session.nextTopicOutbound) {
      return session;
    }

    return {
      ...session,
      // Move current to previous (for grace period)
      previousTopicInbound: session.currentTopicInbound,
      previousTopicExpiry: Date.now() + TOPIC_TRANSITION_WINDOW_MS,
      // Promote next to current
      currentTopicInbound: session.nextTopicInbound,
      currentTopicOutbound: session.nextTopicOutbound,
      // Clear next (will be computed on next DH ratchet)
      nextTopicInbound: undefined,
      nextTopicOutbound: undefined,
      // Increment epoch
      topicEpoch: session.topicEpoch + 1,
      updatedAt: Date.now(),
    };
  }
}