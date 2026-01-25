// src/services/EventProcessorService.ts
// CLEANED VERSION - uses VerbethClient for session creation

/**
 * Event Processing Service.
 *
 * Handles decoding, verification, decryption, and persistence of blockchain events.
 * Uses VerbethClient SDK methods for session management and topic derivation.
 */

import { AbiCoder, getBytes } from "ethers";
import {
  type IdentityContext,
  type VerbethClient,
} from "@verbeth/sdk";

import { dbService } from "./DbService.js";
import {
  Contact,
  Message,
  PendingHandshake,
  ProcessedEvent,
  generateTempMessageId,
} from "../types.js";


export function generateMessageId(
  txHash: string,
  log: { logIndex?: number; index?: number }
): string {
  const idx =
    typeof log.logIndex !== "undefined"
      ? log.logIndex
      : typeof log.index !== "undefined"
      ? log.index
      : 0;
  return `${txHash}-${idx}`;
}

// =============================================================================
// Result Types
// =============================================================================

export interface HandshakeResult {
  pendingHandshake: PendingHandshake;
  systemMessage: Message;
}

export interface HandshakeResponseResult {
  updatedContact: Contact;
  systemMessage: Message;
}

export interface MessageResult {
  newMessage?: Message;
  messageUpdate?: [string, Partial<Message>];
  contactUpdate?: Contact;
}

// =============================================================================
// Handshake Processing (unchanged - doesn't use ratchet)
// =============================================================================

export async function processHandshakeEvent(
  event: ProcessedEvent,
  address: string,
  readProvider: any,
  identityContext: IdentityContext,
  verbethClient: VerbethClient,
  onLog: (msg: string) => void
): Promise<HandshakeResult | null> {
  try {
    const log = event.rawLog;
    const abiCoder = new AbiCoder();
    const decoded = abiCoder.decode(["bytes", "bytes", "bytes"], log.data);
    const [identityPubKeyBytes, ephemeralPubKeyBytes, plaintextPayloadBytes] = decoded;

    const unifiedPubKeys = getBytes(identityPubKeyBytes);
    const decodedKeys = verbethClient.payload.decodeUnifiedPubKeys(unifiedPubKeys);

    if (!decodedKeys) {
      onLog("✗ Failed to decode unified public keys");
      return null;
    }

    const identityPubKey = decodedKeys.identityPubKey;
    const signingPubKey = decodedKeys.signingPubKey;
    const ephemeralPubKeyFull = getBytes(ephemeralPubKeyBytes);
    // Extract X25519 part (first 32 bytes) for backward compatibility
    const ephemeralPubKey = ephemeralPubKeyFull.length > 32
      ? ephemeralPubKeyFull.slice(0, 32)
      : ephemeralPubKeyFull;
    const plaintextPayload = new TextDecoder().decode(
      getBytes(plaintextPayloadBytes)
    );

    const cleanSenderAddress = "0x" + log.topics[2].slice(-40);
    const recipientHash = log.topics[1];

    let handshakeContent;
    let hasValidIdentityProof = false;

    try {
      handshakeContent = verbethClient.payload.parseHandshakePayload(plaintextPayload);
      hasValidIdentityProof = true;
    } catch (error) {
      handshakeContent = {
        plaintextPayload: plaintextPayload,
        identityProof: null,
      };
      hasValidIdentityProof = false;
    }

    let isVerified = false;
    if (hasValidIdentityProof) {
      try {
        const handshakeEvent = {
          recipientHash,
          sender: cleanSenderAddress,
          pubKeys: identityPubKeyBytes,
          ephemeralPubKey: ephemeralPubKeyBytes,
          plaintextPayload: plaintextPayload,
        };

        isVerified = await verbethClient.verify.verifyHandshakeIdentity(
          handshakeEvent,
          readProvider,
          identityContext
        );
      } catch (error) {
        onLog(`Failed to verify handshake identity: ${error}`);
      }
    }

    let identityAddress = cleanSenderAddress;
    if (hasValidIdentityProof && handshakeContent.identityProof?.message) {
      try {
        const parsed = verbethClient.utils.parseBindingMessage(handshakeContent.identityProof.message);
        if (parsed.address) {
          identityAddress = parsed.address;
        }
      } catch (e) {}
    }

    const existingContact = await dbService.getContact(identityAddress, address);
    const isExistingEstablished = existingContact?.status === "established";

    const pendingHandshake: PendingHandshake = {
      id: log.transactionHash,
      ownerAddress: address,
      sender: identityAddress,
      emitterAddress: cleanSenderAddress,
      identityPubKey,
      signingPubKey,
      ephemeralPubKey,           // X25519 only (32 bytes)
      ephemeralPubKeyFull,       // Full key (may include KEM - 1216 bytes)
      message: handshakeContent.plaintextPayload,
      timestamp: Date.now(),
      blockNumber: log.blockNumber,
      verified: isVerified,
      isExistingContact: isExistingEstablished,
    };

    const messagePrefix = pendingHandshake.isExistingContact
      ? "Session reset request received"
      : "Request received";

    const systemMessage: Message = {
      id: generateTempMessageId(),
      topic: "",
      sender: identityAddress,
      recipient: address,
      ciphertext: "",
      timestamp: Date.now(),
      blockTimestamp: Date.now(),
      blockNumber: log.blockNumber,
      direction: "incoming",
      decrypted: `${messagePrefix}: "${handshakeContent.plaintextPayload}"`,
      read: true,
      nonce: 0,
      dedupKey: `handshake-received-${log.transactionHash}`,
      type: "system",
      ownerAddress: address,
      status: "confirmed",
      verified: isVerified,
    };

    await dbService.savePendingHandshake(pendingHandshake);
    await dbService.saveMessage(systemMessage);

    const logSuffix = isExistingEstablished ? " (session reset)" : "";
    onLog(
      `📨 Handshake received from ${identityAddress.slice(0, 8)}...${logSuffix} ${
        isVerified ? "✅" : "⚠️"
      }: "${handshakeContent.plaintextPayload}"`
    );

    return { pendingHandshake, systemMessage };
  } catch (error) {
    onLog(`✗ Failed to process handshake log: ${error}`);
    return null;
  }
}

// =============================================================================
// Handshake Response Processing
// Uses VerbethClient.createInitiatorSession for topic derivation
// =============================================================================

export async function processHandshakeResponseEvent(
  event: ProcessedEvent,
  address: string,
  readProvider: any,
  identityContext: IdentityContext,
  verbethClient: VerbethClient,
  onLog: (msg: string) => void
): Promise<HandshakeResponseResult | null> {
  try {
    const log = event.rawLog;
    const abiCoder = new AbiCoder();
    const [responderEphemeralRBytes, ciphertextBytes] = abiCoder.decode(
      ["bytes32", "bytes"],
      log.data
    );

    const ciphertextJson = new TextDecoder().decode(getBytes(ciphertextBytes));
    const responder = "0x" + log.topics[2].slice(-40);
    const inResponseTo = log.topics[1];

    const currentContacts = await dbService.getAllContacts(address);

    const contact = currentContacts.find(
      (c) =>
        c.address.toLowerCase() === event.matchedContactAddress?.toLowerCase() &&
        c.status === "handshake_sent"
    );

    if (!contact || !contact.handshakeEphemeralSecret) {
      onLog(
        `❓ Received handshake response but no matching pending contact found (responder: ${responder.slice(0, 8)}...)`
      );
      return null;
    }

    const responseEvent = {
      inResponseTo,
      responder,
      responderEphemeralR: responderEphemeralRBytes,
      ciphertext: ciphertextJson,
    };

    const initiatorEphemeralSecret = getBytes(contact.handshakeEphemeralSecret);

    // Get stored KEM secret for PQ-hybrid decapsulation
    const initiatorKemSecret = contact.handshakeKemSecret
      ? getBytes(contact.handshakeKemSecret)
      : undefined;

    if (!initiatorKemSecret) {
      onLog(`✗ Missing KEM secret for contact ${contact.address.slice(0, 8)}...`);
      return null;
    }

    const result = await verbethClient.verify.verifyAndExtractHandshakeResponseKeys(
      responseEvent,
      initiatorEphemeralSecret,
      initiatorKemSecret,
      readProvider,
      identityContext
    );

    if (!result.isValid || !result.keys) {
      onLog(`✗ Invalid handshake response from ${responder.slice(0, 8)}...`);
      return null;
    }

    // =========================================================================
    // Create session using VerbethClient convenience method
    // =========================================================================
    const ratchetSession = verbethClient.createInitiatorSessionFromHsr({
      contactAddress: contact.address,
      myEphemeralSecret: initiatorEphemeralSecret,
      myKemSecret: initiatorKemSecret,
      hsrEvent: {
        inResponseToTag: inResponseTo as `0x${string}`,
        responderEphemeralPubKey: result.keys.ephemeralPubKey,
        kemCiphertext: result.keys.kemCiphertext,
      },
    });

    // Save session to DB (SDK will pick it up via SessionStore)
    await dbService.saveRatchetSession(ratchetSession);

    const updatedContact: Contact = {
      ...contact,
      status: "established",
      identityPubKey: result.keys.identityPubKey,
      signingPubKey: result.keys.signingPubKey,
      topicOutbound: ratchetSession.currentTopicOutbound,
      topicInbound: ratchetSession.currentTopicInbound,
      conversationId: ratchetSession.conversationId,
      handshakeEphemeralSecret: undefined, // Clear after use
      handshakeKemSecret: undefined,       // Clear after use
      lastMessage: result.keys.note || "Connection established",
      lastTimestamp: Date.now(),
    };

    await dbService.saveContact(updatedContact);

    const systemMessage: Message = {
      id: generateTempMessageId(),
      topic: ratchetSession.currentTopicOutbound,
      sender: contact.address,
      recipient: address,
      ciphertext: "",
      timestamp: Date.now(),
      blockTimestamp: Date.now(),
      blockNumber: log.blockNumber,
      direction: "incoming",
      decrypted: `Connection established: "${result.keys.note || "Hello!"}"`,
      read: true,
      nonce: 0,
      dedupKey: `handshake-response-${log.transactionHash}`,
      type: "system",
      ownerAddress: address,
      status: "confirmed",
    };

    await dbService.saveMessage(systemMessage);

    onLog(
      `✅ Handshake response verified from ${contact.address.slice(0, 8)}... - ratchet session created`
    );

    return { updatedContact, systemMessage };
  } catch (error) {
    onLog(`✗ Failed to process handshake response: ${error}`);
    return null;
  }
}

// =============================================================================
// Message Processing - Uses VerbethClient for decryption
// =============================================================================

/**
 * Process a message event using VerbethClient's decryptMessage.
 * 
 * For outgoing messages:
 * - Look up pending record by txHash
 * - Finalize the pending record
 * - Use pending.id to update the message (which IS the optimistic message ID)
 */
export async function processMessageEvent(
  event: ProcessedEvent,
  address: string,
  emitterAddress: string | undefined,
  verbethClient: VerbethClient,
  onLog: (msg: string) => void
): Promise<MessageResult | null> {
  try {
    const log = event.rawLog;
    const abiCoder = new AbiCoder();
    const decoded = abiCoder.decode(["bytes", "uint256", "uint256"], log.data);
    const [ciphertextBytes, timestamp, nonce] = decoded;
    const topic = log.topics[2];

    const sender = "0x" + log.topics[1].slice(-40);
    const ciphertextHex = ciphertextBytes as string;
    const ciphertextRaw = getBytes(ciphertextHex);
    const dedupKey = `${address.toLowerCase()}:${generateMessageId(log.transactionHash, log)}`;

    const isOurMessage =
      sender.toLowerCase() === address.toLowerCase() ||
      (emitterAddress && sender.toLowerCase() === emitterAddress.toLowerCase());

    // Check dedup for incoming messages
    if (!isOurMessage) {
      const already = await dbService.getByDedupKey(dedupKey);
      if (already) return null;
    }

    onLog(
      `🔍 Processing message: sender=${sender.slice(0, 8)}..., isOurMessage=${isOurMessage}, topic=${topic.slice(0, 10)}...`
    );

    // =========================================================================
    // OUTGOING MESSAGE CONFIRMATION - Use txHash lookup
    // =========================================================================
    if (isOurMessage) {
      onLog(`🔄 Confirming outgoing message: tx=${log.transactionHash.slice(0, 10)}...`);

      // Look up pending by txHash
      const pending = await dbService.getPendingOutboundByTxHash(log.transactionHash);

      if (pending && pending.status === "submitted") {
        // Finalize the pending record (clean up)
        const finalized = await dbService.finalizePendingOutbound(pending.id);

        if (!finalized) {
          onLog(`⚠️ Failed to finalize pending outbound ${pending.id.slice(0, 8)}...`);
          return null;
        }

        // Update the message using pending.id (which IS the optimistic message ID)
        const newId = generateMessageId(log.transactionHash, log);
        const updates: Partial<Message> = {
          id: newId,
          status: "confirmed",
          blockNumber: log.blockNumber,
          blockTimestamp: Date.now(),
          ciphertext: ciphertextHex,
          nonce: Number(nonce),
          dedupKey,
        };

        await dbService.updateMessage(pending.id, updates);
        await dbService.upsertDedup({
          key: dedupKey,
          messageId: newId,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
        });

        onLog(`✅ Message confirmed: "${finalized.plaintext.slice(0, 30)}..." (${pending.id.slice(0, 8)}... → ${newId.slice(0, 8)}...)`);

        return {
          messageUpdate: [pending.id, updates],
        };
      }

      onLog(`⚠️ Outgoing message on-chain but no pending record found`);
      return null;
    }

    // =========================================================================
    // INCOMING MESSAGE - Use SDK's decryptMessage
    // =========================================================================

    // Get contact for signing key
    const session = await dbService.getRatchetSessionByAnyInboundTopic(topic);
    if (!session) {
      onLog(`❓ Received message on unknown topic: ${topic.slice(0, 10)}...`);
      return null;
    }

    const contact = await dbService.getContact(session.contactAddress, address);
    if (!contact?.signingPubKey) {
      onLog(`✗ No signing key for contact ${session.contactAddress.slice(0, 8)}...`);
      return null;
    }

    // Decrypt using SDK (handles session lookup, signature verification, topic promotion)
    const decrypted = await verbethClient.decryptMessage(
      topic,
      ciphertextRaw,
      contact.signingPubKey,
      false // not our message
    );

    if (!decrypted) {
      onLog(`✗ Failed to decrypt message from ${contact.address.slice(0, 8)}...`);
      return null;
    }

    // Create message record
    const message: Message = {
      id: generateMessageId(log.transactionHash, log),
      topic: topic,
      sender: contact.address,
      recipient: address,
      ciphertext: ciphertextHex,
      timestamp: Number(timestamp) * 1000,
      blockTimestamp: Date.now(),
      blockNumber: log.blockNumber,
      direction: "incoming",
      decrypted: decrypted.plaintext,
      read: false,
      nonce: Number(nonce),
      dedupKey,
      type: "text",
      ownerAddress: address,
      status: "confirmed",
    };

    // Update contact with current topics (may have ratcheted)
    const updatedContact: Contact = {
      ...contact,
      topicInbound: decrypted.session.currentTopicInbound,
      topicOutbound: decrypted.session.currentTopicOutbound,
      lastMessage: decrypted.plaintext,
      lastTimestamp: Date.now(),
    };

    // Persist
    const saved = await dbService.saveMessage(message);
    if (saved) {
      await dbService.upsertDedup({
        key: dedupKey,
        messageId: message.id,
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      });
      await dbService.saveContact(updatedContact);
    }

    onLog(`📩 Message from ${contact.address.slice(0, 8)}...: "${decrypted.plaintext}"`);

    return saved ? { newMessage: message, contactUpdate: updatedContact } : null;
  } catch (error) {
    onLog(`✗ Failed to process message: ${error}`);
    return null;
  }
}