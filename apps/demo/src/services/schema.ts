import { Dexie, Table } from "dexie";
import type {
  StoredIdentity,
  Contact,
  Message,
  PendingHandshake,
  AppSettings,
} from "../types.js";

export class VerbEthDatabase extends Dexie {
  identity!: Table<StoredIdentity, string>;
  contacts!: Table<Contact, string>;
  messages!: Table<Message, string>;
  pendingHandshakes!: Table<PendingHandshake, string>;
  settings!: Table<AppSettings, string>;
  dedup!: Dexie.Table<{ key: string; messageId: string; txHash: string; blockNumber: number }, string>;


  constructor() {
    super("VerbEthDB");

    this.version(1).stores({
      identity: "address",
      contacts:
        "[address+ownerAddress], ownerAddress, lastTimestamp, status, topicOutbound, topicInbound",
      messages:
        "id, ownerAddress, sender, recipient, topic, nonce, timestamp, blockTimestamp, read, status, [ownerAddress+sender+status], [ownerAddress+sender+topic+nonce+status]",
      dedup: "key, messageId, txHash, blockNumber", // key is PRIMARY KEY
      pendingHandshakes: "id, ownerAddress, sender, timestamp, verified",
      settings: "name",
    });

  }
}
