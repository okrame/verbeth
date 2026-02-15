import { VerbEthDatabase } from "./schema.js";
import type { PendingOutbound } from "../types.js";
import { serializeRatchetSession, deserializeRatchetSession } from "../types.js";
import type { RatchetSession } from "@verbeth/sdk";
import { pruneExpiredSkippedKeys } from "@verbeth/sdk";

export class RatchetDbService {
  constructor(private readonly db: VerbEthDatabase) {}

  /* ========================= RATCHET SESSIONS ========================= */

  async saveRatchetSession(session: RatchetSession): Promise<void> {
    const stored = serializeRatchetSession(session);
    console.log(`💾 Saving ratchet session: ${stored.conversationId.slice(0, 10)}... (sendingMsgNumber=${stored.sendingMsgNumber}, topicEpoch=${stored.topicEpoch})`);
    await this.db.ratchetSessions.put(stored);
  }

  async getRatchetSessionByConversation(conversationId: string): Promise<RatchetSession | null> {
    const stored = await this.db.ratchetSessions.get(conversationId);
    if (!stored) return null;
    
    const session = deserializeRatchetSession(stored);
    const pruned = pruneExpiredSkippedKeys(session);
    
    if (pruned.skippedKeys.length !== session.skippedKeys.length) {
      await this.saveRatchetSession(pruned);
    }
    
    return pruned;
  }

  /**
   * Find session by any active inbound topic (current, next, or previous).
   * Handles topic ratcheting grace period and pre-computed next topics.
   */
  async getRatchetSessionByAnyInboundTopic(topic: string): Promise<RatchetSession | null> {
    const topicLower = topic.toLowerCase();
    
    // try current topic first
    let stored = await this.db.ratchetSessions
      .where("currentTopicInbound")
      .equals(topicLower)
      .first();
      
    if (stored) {
      const session = deserializeRatchetSession(stored);
      const pruned = pruneExpiredSkippedKeys(session);
      if (pruned.skippedKeys.length !== session.skippedKeys.length) {
        await this.saveRatchetSession(pruned);
      }
      return pruned;
    }
    
    // try next topic (pre-computed for incoming DH ratchet)
    stored = await this.db.ratchetSessions
      .where("nextTopicInbound")
      .equals(topicLower)
      .first();
      
    if (stored) {
      console.log(`🔄 Found session via nextTopicInbound for topic ${topicLower.slice(0, 10)}...`);
      const session = deserializeRatchetSession(stored);
      const pruned = pruneExpiredSkippedKeys(session);
      if (pruned.skippedKeys.length !== session.skippedKeys.length) {
        await this.saveRatchetSession(pruned);
      }
      return pruned;
    }
    
    // Try previous topic (check expiry)
    stored = await this.db.ratchetSessions
      .where("previousTopicInbound")
      .equals(topicLower)
      .first();
      
    if (stored) {
      const session = deserializeRatchetSession(stored);
      const pruned = pruneExpiredSkippedKeys(session);
      if (pruned.skippedKeys.length !== session.skippedKeys.length) {
        await this.saveRatchetSession(pruned);
      }
      return pruned;
    }
    
    return null;
  }

  /**
   * Get all active inbound topics for a user (for event filtering).
   * Returns current, next, and non-expired previous topics.
   */
  async getAllActiveInboundTopics(myAddress: string): Promise<string[]> {
    const sessions = await this.db.ratchetSessions
      .where("myAddress")
      .equals(myAddress.toLowerCase())
      .toArray();
      
    const topics: string[] = [];

    for (const s of sessions) {
      // Current topic
      if (s.currentTopicInbound) {
        topics.push(s.currentTopicInbound);
      }
      // Next topic (pre-computed for incoming DH ratchet)
      if (s.nextTopicInbound) {
        topics.push(s.nextTopicInbound);
      }
      // Previous topic (always include — crypto safety is enforced by ratchetDecrypt, not expiry)
      if (s.previousTopicInbound) {
        topics.push(s.previousTopicInbound);
      }
    }
    
    return [...new Set(topics)];
  }

  async deleteRatchetSession(conversationId: string): Promise<void> {
    await this.db.ratchetSessions.delete(conversationId);
    console.log(`🗑️ Deleted ratchet session: ${conversationId.slice(0, 10)}...`);
  }

  /* ========================= PENDING OUTBOUND ========================= */

  async savePendingOutbound(pending: PendingOutbound): Promise<void> {
    console.log(`📤 Saving pending outbound: ${pending.id.slice(0, 10)}...`);
    await this.db.pendingOutbound.put(pending);
  }

  async getPendingOutbound(id: string): Promise<PendingOutbound | null> {
    return await this.db.pendingOutbound.get(id) ?? null;
  }

  async getPendingOutboundByTxHash(txHash: string): Promise<PendingOutbound | null> {
    return await this.db.pendingOutbound
      .where("txHash")
      .equals(txHash.toLowerCase())
      .first() ?? null;
  }

  async getPendingOutboundByConversation(conversationId: string): Promise<PendingOutbound[]> {
    return await this.db.pendingOutbound
      .where("conversationId")
      .equals(conversationId)
      .filter((p) => p.status === "preparing" || p.status === "submitted")
      .toArray();
  }

  async updatePendingOutboundStatus(
    id: string,
    status: PendingOutbound["status"],
    txHash?: string
  ): Promise<void> {
    const updates: Partial<PendingOutbound> = { status };
    if (txHash) {
      updates.txHash = txHash.toLowerCase();
    }
    await this.db.pendingOutbound.update(id, updates);
    console.log(`📝 Updated pending outbound ${id.slice(0, 10)}... status to: ${status}`);
  }

  async finalizePendingOutbound(id: string): Promise<{ plaintext: string } | null> {
    const pending = await this.db.pendingOutbound.get(id);
    if (!pending) {
      console.warn(`⚠️ Pending outbound ${id} not found for finalization`);
      return null;
    }
    await this.db.pendingOutbound.delete(id);
    console.log(`✅ Finalized pending outbound ${id.slice(0, 10)}...`);
    return { plaintext: pending.plaintext };
  }

  async deletePendingOutbound(id: string): Promise<void> {
    await this.db.pendingOutbound.delete(id);
    console.log(`🗑️ Deleted pending outbound: ${id.slice(0, 10)}...`);
  }

  async cleanupStalePendingOutbound(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const stale = await this.db.pendingOutbound
      .where("createdAt")
      .below(cutoff)
      .toArray();

    for (const p of stale) {
      await this.db.pendingOutbound.delete(p.id);
    }

    if (stale.length > 0) {
      console.log(`🧹 Cleaned up ${stale.length} stale pending outbound records`);
    }

    return stale.length;
  }
}