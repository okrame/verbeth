// src/services/schema.ts

import { Dexie, Table } from "dexie";
import type {
  StoredIdentity,
  Contact,
  Message,
  PendingHandshake,
  AppSettings,
  StoredRatchetSession,
  PendingOutbound,
} from "../types.js";

export class VerbEthDatabase extends Dexie {
  identity!: Table<StoredIdentity, string>;
  contacts!: Table<Contact, string>;
  messages!: Table<Message, string>;
  pendingHandshakes!: Table<PendingHandshake, string>;
  settings!: Table<AppSettings, string>;
  dedup!: Table<{ key: string; messageId: string; txHash: string; blockNumber: number }, string>;
  
  // ratchet tables
  ratchetSessions!: Table<StoredRatchetSession, string>;
  pendingOutbound!: Table<PendingOutbound, string>;

  constructor() {
    super("VerbEthDB");

    this.version(1).stores({
      identity: "address",
      contacts:
        "[address+ownerAddress], ownerAddress, lastTimestamp, status, topicOutbound, topicInbound, emitterAddress, conversationId",
      messages:
        "id, ownerAddress, sender, recipient, topic, nonce, timestamp, blockTimestamp, read, status, [ownerAddress+sender+status], [ownerAddress+sender+topic+nonce+status]",
      dedup: "key, messageId, txHash, blockNumber",
      pendingHandshakes: "id, ownerAddress, sender, timestamp, verified, emitterAddress",
      settings: "name",
      ratchetSessions: "conversationId, topicInbound, topicOutbound, currentTopicInbound, nextTopicInbound, previousTopicInbound, myAddress, contactAddress",
      pendingOutbound: "id, conversationId, txHash, status, createdAt",
    });
  }
}