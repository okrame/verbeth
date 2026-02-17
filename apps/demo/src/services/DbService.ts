// src/services/DbService.ts

import { VerbEthDatabase } from "./schema.js";
import type {
  StoredIdentity,
  Contact,
  ContactStatus,
  Message,
  EventType,
  PendingHandshake,
} from "../types.js";
import { RatchetDbService } from "./RatchetDbService.js";

export class DbService {
  private readonly db: VerbEthDatabase;
  public readonly ratchet: RatchetDbService;

  constructor() {
    this.db = new VerbEthDatabase();
    this.ratchet = new RatchetDbService(this.db);
  }

  /* ----------------------------- ADDRESS HELPERS --------------------------- */
  private normalizeAddress(address: string): string {
    return address.toLowerCase();
  }

  /* ----------------------------- IDENTITIES -------------------------------- */
  async saveIdentity(identity: StoredIdentity) {
    const normalizedAddress = this.normalizeAddress(identity.address);
    const normalizedIdentity = { ...identity, address: normalizedAddress };
    console.debug(`[db] saveIdentity ${normalizedAddress.slice(0, 8)}...`);
    return this.db.identity.put(normalizedIdentity);
  }

  async getIdentity(address: string) {
    const normalizedAddress = this.normalizeAddress(address);
    try {
      return await this.db.identity.get(normalizedAddress);
    } catch (error) {
      console.error(`[db] getIdentity failed for ${normalizedAddress.slice(0, 8)}...:`, error);
      return null;
    }
  }

  deleteIdentity(address: string) {
    return this.db.identity.delete(this.normalizeAddress(address));
  }

  /* ------------------------------ CONTACTS --------------------------------- */
  saveContact(contact: Contact) {
    const normalizedContact = {
      ...contact,
      address: this.normalizeAddress(contact.address),
      ownerAddress: this.normalizeAddress(contact.ownerAddress),
    };
    return this.db.contacts.put(normalizedContact);
  }

  getContact(address: string, ownerAddress: string) {
    const normalizedAddress = this.normalizeAddress(address);
    const normalizedOwner = this.normalizeAddress(ownerAddress);
    return this.db.contacts
      .where("[address+ownerAddress]")
      .equals([normalizedAddress, normalizedOwner])
      .first();
  }

  async getAllContacts(ownerAddress: string) {
    const normalizedOwner = this.normalizeAddress(ownerAddress);

    const contacts = await this.db.contacts
      .where("ownerAddress")
      .equals(normalizedOwner)
      .toArray();

    const sorted = contacts.sort(
      (a, b) => (b.lastTimestamp ?? 0) - (a.lastTimestamp ?? 0)
    );
    return sorted;
  }

  updateContactStatus(address: string, status: Contact["status"]) {
    const normalizedAddress = this.normalizeAddress(address);
    return this.db.contacts.update(normalizedAddress, { status });
  }

  deleteContact(address: string) {
    const normalizedAddress = this.normalizeAddress(address);
    return this.db.contacts.delete(normalizedAddress);
  }

  async upsertDedup(entry: {
    key: string; // `${ownerAddress}:${txHash}-${logIndex}`
    messageId: string;
    txHash: string;
    blockNumber: number;
  }) {
    const prev = await this.db.dedup.get(entry.key);
    if (!prev || entry.blockNumber >= prev.blockNumber) {
      await this.db.dedup.put(entry); // prefer newest block
    }
  }

  async getByDedupKey(key: string) {
    return this.db.dedup.get(key);
  }

  private buildEventReceiptKey(
    ownerAddress: string,
    eventType: EventType,
    txHash: string,
    logIndex: number
  ): string {
    const normalizedOwner = this.normalizeAddress(ownerAddress);
    return `event:${normalizedOwner}:${eventType}:${txHash.toLowerCase()}-${logIndex}`;
  }

  async hasProcessedEvent(
    ownerAddress: string,
    eventType: EventType,
    txHash: string,
    logIndex: number
  ): Promise<boolean> {
    const key = this.buildEventReceiptKey(
      ownerAddress,
      eventType,
      txHash,
      logIndex
    );
    const existing = await this.db.dedup.get(key);
    return !!existing;
  }

  async markEventProcessed(
    ownerAddress: string,
    eventType: EventType,
    txHash: string,
    logIndex: number,
    blockNumber: number
  ): Promise<void> {
    const key = this.buildEventReceiptKey(
      ownerAddress,
      eventType,
      txHash,
      logIndex
    );
    await this.upsertDedup({
      key,
      messageId: key,
      txHash: txHash.toLowerCase(),
      blockNumber,
    });
  }

  /* ------------------------------ MESSAGES --------------------------------- */
  async saveMessage(message: Message): Promise<boolean> {
    if (await this.db.messages.get(message.id)) {
      console.debug(`Message ${message.id} already in DB`);
      return false;
    }

    const normalizedMessage = {
      ...message,
      sender: this.normalizeAddress(message.sender),
      recipient: message.recipient
        ? this.normalizeAddress(message.recipient)
        : undefined,
      ownerAddress: this.normalizeAddress(message.ownerAddress),
    };

    if (
      normalizedMessage.direction === "outgoing" &&
      normalizedMessage.recipient
    ) {
      await this.updateContactLastMessage(
        normalizedMessage.recipient,
        normalizedMessage.ownerAddress,
        normalizedMessage.decrypted || "Encrypted message",
        normalizedMessage.timestamp
      );
    } else if (normalizedMessage.direction === "incoming") {
      await this.updateContactLastMessage(
        normalizedMessage.sender,
        normalizedMessage.ownerAddress,
        normalizedMessage.decrypted || "Encrypted message",
        normalizedMessage.timestamp
      );
    }

    await this.db.messages.put(normalizedMessage);
    return true;
  }

  async updateMessage(
    messageId: string,
    updates: Partial<Message>
  ): Promise<boolean> {
    try {
      // If we're updating the ID, we need to handle it specially
      if (updates.id && updates.id !== messageId) {
        const oldMessage = await this.getMessage(messageId);
        if (oldMessage) {
          const newMessage = { ...oldMessage, ...updates };
          await this.deleteMessage(messageId);
          await this.saveMessage(newMessage);
          return true;
        }
        return false;
      }

      const result = await this.db.messages.update(messageId, updates);
      return result > 0;
    } catch (error) {
      console.error(`[db] updateMessage failed for ${messageId.slice(0, 8)}...:`, error);
      return false;
    }
  }

  async findPendingMessage(
    sender: string,
    topic: string,
    nonce: number,
    owner: string
  ): Promise<Message | undefined> {
    const normalizedSender = this.normalizeAddress(sender);
    const normalizedOwner = this.normalizeAddress(owner);

    // Try exact match first using compound index
    const exactMatch = await this.db.messages
      .where("[ownerAddress+sender+topic+nonce+status]")
      .equals([normalizedOwner, normalizedSender, topic, nonce, "pending"])
      .first();

    if (exactMatch) return exactMatch;

    // FALLBACK: Find by content and recent timestamp
    const recentPendingMessages = await this.db.messages
      .where("[ownerAddress+sender+status]")
      .equals([normalizedOwner, normalizedSender, "pending"])
      .reverse()
      .limit(3)
      .toArray();

    return recentPendingMessages[0];
  }

  async findMessageByDedupKey(dedupKey: string): Promise<Message | undefined> {
    return this.db.messages.where("dedupKey").equals(dedupKey).first();
  }

  async updateContactLastMessage(
    address: string,
    ownerAddress: string,
    lastMessage: string,
    lastTimestamp?: number
  ) {
    const normalizedAddress = this.normalizeAddress(address);
    const normalizedOwner = this.normalizeAddress(ownerAddress);

    return this.db.contacts
      .where("ownerAddress")
      .equals(normalizedOwner)
      .filter((c) => c.address === normalizedAddress)
      .modify({
        lastMessage,
        lastTimestamp: lastTimestamp ?? Date.now(),
      });
  }

  getMessage(id: string) {
    return this.db.messages.get(id);
  }

  async getMessagesByContact(
    contact: string,
    ownerAddress: string,
    limit = 50
  ) {
    const normalizedContact = this.normalizeAddress(contact);
    const normalizedOwner = this.normalizeAddress(ownerAddress);

    return this.db.messages
      .where("ownerAddress")
      .equals(normalizedOwner)
      .filter(
        (m) =>
          m.sender === normalizedContact || m.recipient === normalizedContact
      )
      .reverse()
      .limit(limit)
      .toArray();
  }

  async getAllMessages(ownerAddress: string, limit = 100) {
    const normalizedOwner = this.normalizeAddress(ownerAddress);
    const messages = await this.db.messages
      .where("ownerAddress")
      .equals(normalizedOwner)
      .toArray();

    const sorted = messages
      .sort((a, b) => b.blockTimestamp - a.blockTimestamp)
      .slice(0, limit);
    return sorted;
  }

  markMessageAsRead(id: string) {
    return this.db.messages.update(id, { read: true });
  }

  async markMessagesAsLost(
    ownerAddress: string,
    contactAddress: string,
    afterTimestamp: number
  ): Promise<number> {
    const normalizedOwner = this.normalizeAddress(ownerAddress);
    const normalizedContact = this.normalizeAddress(contactAddress);

    const messages = await this.db.messages
      .where("ownerAddress")
      .equals(normalizedOwner)
      .filter(
        (m) =>
          m.direction === "outgoing" &&
          m.recipient?.toLowerCase() === normalizedContact &&
          m.timestamp > afterTimestamp &&
          m.type !== "system"
      )
      .toArray();

    for (const msg of messages) {
      await this.db.messages.update(msg.id, { isLost: true });
    }

    return messages.length;
  }

  getUnreadMessagesCount() {
    return this.db.messages.filter((m) => !m.read).count();
  }

  deleteMessage(id: string) {
    return this.db.messages.delete(id);
  }

  /* ------------------------- PENDING HANDSHAKES --------------------------- */
  savePendingHandshake(h: PendingHandshake) {
    const normalizedHandshake = {
      ...h,
      sender: this.normalizeAddress(h.sender),
      ownerAddress: this.normalizeAddress(h.ownerAddress),
    };
    return this.db.pendingHandshakes.put(normalizedHandshake);
  }

  getPendingHandshake(id: string) {
    return this.db.pendingHandshakes.get(id);
  }

  async getAllPendingHandshakes(ownerAddress: string) {
    const normalizedOwner = this.normalizeAddress(ownerAddress);
    const handshakes = await this.db.pendingHandshakes
      .where("ownerAddress")
      .equals(normalizedOwner)
      .toArray();

    const sorted = handshakes.sort((a, b) => b.timestamp - a.timestamp);
    return sorted;
  }

  deletePendingHandshake(id: string) {
    return this.db.pendingHandshakes.delete(id);
  }

  /* -------------------------------- SETTINGS ------------------------------ */
  setSetting(name: string, value: any) {
    return this.db.settings.put({ name, value });
  }
  async getSetting(name: string) {
    return (await this.db.settings.get(name))?.value;
  }
  deleteSetting(name: string) {
    return this.db.settings.delete(name);
  }

  /* --------------------------------- SYNC --------------------------------- */
  getLastKnownBlock(addr: string) {
    const normalizedAddr = this.normalizeAddress(addr);
    return this.getSetting(`lastKnownBlock_${normalizedAddr}`);
  }
  setLastKnownBlock(addr: string, n: number) {
    const normalizedAddr = this.normalizeAddress(addr);
    return this.setSetting(`lastKnownBlock_${normalizedAddr}`, n);
  }
  getOldestScannedBlock(addr: string) {
    const normalizedAddr = this.normalizeAddress(addr);
    return this.getSetting(`oldestScannedBlock_${normalizedAddr}`);
  }
  setOldestScannedBlock(addr: string, n: number) {
    const normalizedAddr = this.normalizeAddress(addr);
    return this.setSetting(`oldestScannedBlock_${normalizedAddr}`, n);
  }
  getInitialScanComplete(addr: string) {
    const normalizedAddr = this.normalizeAddress(addr);
    return this.getSetting(`initialScanComplete_${normalizedAddr}`);
  }
  setInitialScanComplete(addr: string, ok: boolean) {
    const normalizedAddr = this.normalizeAddress(addr);
    return this.setSetting(`initialScanComplete_${normalizedAddr}`, ok);
  }

  /* ------------------------------ UTILITIES ------------------------------- */
  async clearAllData() {
    console.log("🧹 Clearing all database data...");
    await this.db.transaction(
      "rw",
      [
        this.db.identity,
        this.db.contacts,
        this.db.messages,
        this.db.pendingHandshakes,
        this.db.settings,
        this.db.ratchetSessions,
        this.db.pendingOutbound,
      ],
      async () => {
        await this.db.identity.clear();
        await this.db.contacts.clear();
        await this.db.messages.clear();
        await this.db.pendingHandshakes.clear();
        await this.db.settings.clear();
        await this.db.ratchetSessions.clear();
        await this.db.pendingOutbound.clear();
      }
    );
    console.log("All database data cleared");
  }

  async clearUserData(addr: string) {
    const normalizedAddr = this.normalizeAddress(addr);
    console.log(`Clearing data for user ${normalizedAddr.slice(0, 8)}...`);
    await this.db.transaction(
      "rw",
      [
        this.db.identity,
        this.db.contacts,
        this.db.messages,
        this.db.pendingHandshakes,
        this.db.settings,
        this.db.ratchetSessions,
        this.db.pendingOutbound,
      ],
      async () => {
        await this.db.identity.delete(normalizedAddr);

        // Delete only data owned by this user
        await this.db.contacts
          .where("ownerAddress")
          .equals(normalizedAddr)
          .delete();
        await this.db.messages
          .where("ownerAddress")
          .equals(normalizedAddr)
          .delete();
        await this.db.pendingHandshakes
          .where("ownerAddress")
          .equals(normalizedAddr)
          .delete();

        //Delete ratchet data
        const sessions = await this.db.ratchetSessions
          .where("myAddress")
          .equals(normalizedAddr)
          .toArray();
        for (const s of sessions) {
          await this.db.ratchetSessions.delete(s.conversationId);
          await this.db.pendingOutbound
            .where("conversationId")
            .equals(s.conversationId)
            .delete();
        }

        const staleSettings = await this.db.settings
          .where("name")
          .startsWith(`initialScanComplete_${normalizedAddr}`)
          .toArray();
        for (const s of staleSettings) {
          await this.db.settings.delete(s.name);
        }
        await this.db.settings.delete(`lastKnownBlock_${normalizedAddr}`);
        await this.db.settings.delete(`oldestScannedBlock_${normalizedAddr}`);
        await this.db.settings.delete(`syncState_${normalizedAddr}`);

        const dedupForOwner = await this.db.dedup
          .where("key")
          .startsWith(`${normalizedAddr}:`)
          .toArray();
        for (const row of dedupForOwner) {
          await this.db.dedup.delete(row.key);
        }

        const eventReceiptsForOwner = await this.db.dedup
          .where("key")
          .startsWith(`event:${normalizedAddr}:`)
          .toArray();
        for (const row of eventReceiptsForOwner) {
          await this.db.dedup.delete(row.key);
        }
      }
    );
    //this.deduplicator.clear();
    console.log(`User data cleared for ${normalizedAddr.slice(0, 8)}...`);
  }
  /* ----------------------------- SESSION ----------------------------- */

  /**
   * Check if a sender is an existing contact.
   * Used during handshake processing for receiver hints.
   */
  async isExistingContact(
    senderAddress: string,
    ownerAddress: string
  ): Promise<{
    exists: boolean;
    previousStatus?: ContactStatus;
    previousConversationId?: string;
  }> {
    const contact = await this.getContact(senderAddress, ownerAddress);

    if (!contact) {
      return { exists: false };
    }

    return {
      exists: true,
      previousStatus: contact.status,
      previousConversationId: contact.conversationId,
    };
  }

  /* ---------------------------- BACKUP / IMPORT --------------------------- */
  async exportData() {
    console.log("Exporting database...");
    const payload = {
      identity: await this.db.identity.toArray(),
      contacts: await this.db.contacts.toArray(),
      messages: await this.db.messages.toArray(),
      pendingHandshakes: await this.db.pendingHandshakes.toArray(),
      settings: await this.db.settings.toArray(),
      ratchetSessions: await this.db.ratchetSessions.toArray(),
      pendingOutbound: await this.db.pendingOutbound.toArray(),
      exportedAt: Date.now(),
    } as const;

    console.log(
      `Exported ${payload.identity.length} identities, ${payload.contacts.length} contacts, ${payload.messages.length} messages, ${payload.ratchetSessions.length} ratchet sessions`
    );
    return JSON.stringify(payload);
  }

  async importData(json: string) {
    console.log("...Importing database...");
    const data = JSON.parse(json);

    await this.db.transaction(
      "rw",
      [
        this.db.identity,
        this.db.contacts,
        this.db.messages,
        this.db.pendingHandshakes,
        this.db.settings,
        this.db.ratchetSessions,
        this.db.pendingOutbound,
      ],
      async () => {
        if (data.identity) await this.db.identity.bulkPut(data.identity);
        if (data.contacts) await this.db.contacts.bulkPut(data.contacts);
        if (data.messages) await this.db.messages.bulkPut(data.messages);
        if (data.pendingHandshakes)
          await this.db.pendingHandshakes.bulkPut(data.pendingHandshakes);
        if (data.settings) await this.db.settings.bulkPut(data.settings);
        if (data.ratchetSessions)
          await this.db.ratchetSessions.bulkPut(data.ratchetSessions);
        if (data.pendingOutbound)
          await this.db.pendingOutbound.bulkPut(data.pendingOutbound);
      }
    );
    console.log("✅ Database import completed");
  }

  /* -------------------------------- ACCOUNT SWITCH -------------------------------- */
  async switchAccount(newAddress: string) {
    const normalizedAddress = this.normalizeAddress(newAddress);
    console.debug(`[db] switchAccount ${normalizedAddress.slice(0, 8)}...`);

    await Promise.all([
      this.getAllContacts(normalizedAddress),
      this.getAllMessages(normalizedAddress, 1000),
      this.getAllPendingHandshakes(normalizedAddress),
    ]);
  }

  /* ------------------------------ CLEANUP --------------------------------- */
  close() {
    this.db.close();
  }
}

export const dbService = new DbService();
