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
    console.log(`💾 Saving ratchet session: ${stored.conversationId.slice(0, 10)}... (sendingMsgNumber=${stored.sendingMsgNumber})`);
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

  async getRatchetSessionByTopic(topicInbound: string): Promise<RatchetSession | null> {
    const stored = await this.db.ratchetSessions
      .where("topicInbound")
      .equals(topicInbound.toLowerCase())
      .first();
    if (!stored) return null;
    
    const session = deserializeRatchetSession(stored);
    const pruned = pruneExpiredSkippedKeys(session);
    
    if (pruned.skippedKeys.length !== session.skippedKeys.length) {
      await this.saveRatchetSession(pruned);
    }
    
    return pruned;
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