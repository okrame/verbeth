// src/services/EventProcessorService.ts

/**
 * Event Processing Service.
 *
 * Handles decoding, verification, decryption, and persistence of blockchain events.
 * Returns only what's needed for React state updates.
 */

import { AbiCoder, getBytes } from "ethers";
import {
  type IdentityContext,
  type IdentityKeyPair,
  type RatchetSession,
  parseHandshakePayload,
  parseBindingMessage,
  verifyHandshakeIdentity,
  decodeUnifiedPubKeys,
  verifyAndExtractHandshakeResponseKeys,
  deriveDuplexTopics,
  verifyDerivedDuplexTopics,
  computeTagFromInitiator,
  pickOutboundTopic,
  initSessionAsInitiator,
  ratchetDecrypt,
  parseRatchetPayload,
  isRatchetPayload,
  verifyMessageSignature,
} from "@verbeth/sdk";

import { dbService } from "./DbService.js";
import {
  Contact,
  Message,
  PendingHandshake,
  ProcessedEvent,
  MessageDirection,
  MessageType,
  ContactStatus,
  generateTempMessageId,
} from "../types.js";

export function hexToUint8Array(hex: string): Uint8Array {
  const cleanHex = hex.replace("0x", "");
  return new Uint8Array(
    cleanHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
  );
}

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

export interface HandshakeResult {
  pendingHandshake: PendingHandshake;
  systemMessage: Message;
}

export interface HandshakeResponseResult {
  updatedContact: Contact;
  systemMessage: Message;
}

export interface MessageResult {
  /** New message to add */
  newMessage?: Message;
  /** Message update: [originalId, partialUpdates] - will be merged with existing message */
  messageUpdate?: [string, Partial<Message>];
  /** Contact to update */
  contactUpdate?: Contact;
}

// =============================================================================
// Handshake Processing
// =============================================================================

export async function processHandshakeEvent(
  event: ProcessedEvent,
  address: string,
  readProvider: any,
  identityContext: IdentityContext,
  onLog: (msg: string) => void
): Promise<HandshakeResult | null> {
  try {
    const log = event.rawLog;
    const abiCoder = new AbiCoder();
    const decoded = abiCoder.decode(["bytes", "bytes", "bytes"], log.data);
    const [identityPubKeyBytes, ephemeralPubKeyBytes, plaintextPayloadBytes] =
      decoded;

    const unifiedPubKeys = hexToUint8Array(identityPubKeyBytes);
    const decodedKeys = decodeUnifiedPubKeys(unifiedPubKeys);

    if (!decodedKeys) {
      onLog("✗ Failed to decode unified public keys");
      return null;
    }

    const identityPubKey = decodedKeys.identityPubKey;
    const signingPubKey = decodedKeys.signingPubKey;
    const ephemeralPubKey = hexToUint8Array(ephemeralPubKeyBytes);
    const plaintextPayload = new TextDecoder().decode(
      hexToUint8Array(plaintextPayloadBytes)
    );

    const cleanSenderAddress = "0x" + log.topics[2].slice(-40);
    const recipientHash = log.topics[1];

    let handshakeContent;
    let hasValidIdentityProof = false;

    try {
      handshakeContent = parseHandshakePayload(plaintextPayload);
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

        isVerified = await verifyHandshakeIdentity(
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
        const parsed = parseBindingMessage(
          handshakeContent.identityProof.message
        );
        if (parsed.address) {
          identityAddress = parsed.address;
        }
      } catch (e) {}
    }

    const existingContact = await dbService.getContact(identityAddress, address);
    const isExistingEstablished = existingContact?.status === 'established';

    const pendingHandshake: PendingHandshake = {
      id: log.transactionHash,
      ownerAddress: address,
      sender: identityAddress,
      emitterAddress: cleanSenderAddress,
      identityPubKey,
      signingPubKey,
      ephemeralPubKey,
      message: handshakeContent.plaintextPayload,
      timestamp: Date.now(),
      blockNumber: log.blockNumber,
      verified: isVerified,
      isExistingContact: isExistingEstablished,
    };

    const messagePrefix = pendingHandshake.isExistingContact 
      ? 'Session reset request received' 
      : 'Request received';

    const systemMessage: Message = {
      id: generateTempMessageId(),
      topic: "",
      sender: identityAddress,
      recipient: address,
      ciphertext: "",
      timestamp: Date.now(),
      blockTimestamp: Date.now(),
      blockNumber: log.blockNumber,
      direction: "incoming" as const,
      decrypted: `${messagePrefix}: "${handshakeContent.plaintextPayload}"`,
      read: true,
      nonce: 0,
      dedupKey: `handshake-received-${log.transactionHash}`,
      type: "system" as const,
      ownerAddress: address,
      status: "confirmed" as const,
      verified: isVerified,
    };

    // Persist to DB
    await dbService.savePendingHandshake(pendingHandshake);
    await dbService.saveMessage(systemMessage);

    const logSuffix = isExistingEstablished ? ' (session reset)' : '';
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
// =============================================================================

export async function processHandshakeResponseEvent(
  event: ProcessedEvent,
  address: string,
  readProvider: any,
  identityKeyPair: IdentityKeyPair,
  identityContext: IdentityContext,
  onLog: (msg: string) => void
): Promise<HandshakeResponseResult | null> {
  try {
    const log = event.rawLog;
    const abiCoder = new AbiCoder();
    const [responderEphemeralRBytes, ciphertextBytes] = abiCoder.decode(
      ["bytes32", "bytes"],
      log.data
    );

    const ciphertextJson = new TextDecoder().decode(
      hexToUint8Array(ciphertextBytes)
    );

    const responder = "0x" + log.topics[2].slice(-40);
    const inResponseTo = log.topics[1];

    const currentContacts = await dbService.getAllContacts(address);

    onLog(
      `🔍 Debug: Loaded ${currentContacts.length} contacts from DB for handshake response`
    );

    const contact = currentContacts.find(
      (c) =>
        c.address.toLowerCase() ===
          event.matchedContactAddress?.toLowerCase() &&
        c.status === "handshake_sent"
    );

    if (!contact || !contact.handshakeEphemeralSecret) {
      onLog(
        `❓ Received handshake response but no matching pending contact found (responder: ${responder.slice(
          0,
          8
        )}...)`
      );
      return null;
    }

    const responseEvent = {
      inResponseTo,
      responder,
      responderEphemeralR: responderEphemeralRBytes,
      ciphertext: ciphertextJson,
    };

    const result = await verifyAndExtractHandshakeResponseKeys(
      responseEvent,
      getBytes(contact.handshakeEphemeralSecret!),
      readProvider,
      identityContext
    );

    if (!result.isValid || !result.keys) {
      onLog(
        `❌ Failed to verify handshake response from ${contact.address.slice(
          0,
          8
        )}... - invalid signature or tag mismatch`
      );
      return null;
    }

    const { identityPubKey, signingPubKey, ephemeralPubKey, note } =
      result.keys;

    const saltHex = computeTagFromInitiator(
      getBytes(contact.handshakeEphemeralSecret!),
      hexToUint8Array(responderEphemeralRBytes)
    );
    const salt = Uint8Array.from(Buffer.from(saltHex.slice(2), "hex"));

    const duplexTopics = deriveDuplexTopics(
      identityKeyPair.secretKey,
      identityPubKey,
      salt
    );

    const isValidTopics = verifyDerivedDuplexTopics({
      myIdentitySecretKey: identityKeyPair.secretKey,
      theirIdentityPubKey: identityPubKey,
      topicInfo: {
        out: duplexTopics.topicOut,
        in: duplexTopics.topicIn,
        chk: duplexTopics.checksum,
      },
      salt,
    });

    if (!isValidTopics) {
      onLog(
        `❌ Invalid duplex topics checksum for ${contact.address.slice(0, 8)}...`
      );
      return null;
    }

    onLog(
      `✅ Handshake response verified from ${contact.address.slice(0, 8)}...`
    );

    const topicOutbound = pickOutboundTopic(true, duplexTopics);
    const topicInbound = pickOutboundTopic(false, duplexTopics);

    const ratchetSession = initSessionAsInitiator({
      myAddress: address,
      contactAddress: contact.address,
      myHandshakeEphemeralSecret: getBytes(contact.handshakeEphemeralSecret!),
      theirResponderEphemeralPubKey: ephemeralPubKey,
      topicOutbound,
      topicInbound,
    });

    const updatedContact: Contact = {
      ...contact,
      status: "established" as ContactStatus,
      identityPubKey,
      signingPubKey,
      handshakeEphemeralSecret: undefined,
      topicOutbound,
      topicInbound,
      conversationId: ratchetSession.conversationId,
      lastMessage: note || "Handshake accepted",
      lastTimestamp: Date.now(),
    };

    const systemMessage: Message = {
      id: generateTempMessageId(),
      topic: updatedContact.topicInbound || "",
      sender: contact.address,
      recipient: address,
      ciphertext: "",
      timestamp: Date.now(),
      blockTimestamp: Date.now(),
      blockNumber: 0,
      direction: "incoming" as const,
      decrypted: `Request accepted: "${note || "No message"}"`,
      read: true,
      nonce: 0,
      dedupKey: `handshake-response-${inResponseTo}`,
      type: "system" as const,
      ownerAddress: address,
      status: "confirmed" as const,
      verified: true,
    };

    // Persist to DB
    await dbService.saveRatchetSession(ratchetSession);
    await dbService.saveContact(updatedContact);
    await dbService.saveMessage(systemMessage);

    onLog(
      `🤝 Handshake completed with ${contact.address.slice(0, 8)}... : "${
        note || "No message"
      }"`
    );

    return { updatedContact, systemMessage };
  } catch (error) {
    onLog(`✗ Failed to process handshake response log: ${error}`);
    return null;
  }
}

// =============================================================================
// Message Processing (Outgoing Confirmation + Incoming Decryption)
// =============================================================================

export async function processMessageEvent(
  event: ProcessedEvent,
  address: string,
  emitterAddress: string | undefined,
  sessionCache: Map<string, RatchetSession>,
  onLog: (msg: string) => void
): Promise<MessageResult | null> {
  try {
    const log = event.rawLog;
    const abiCoder = new AbiCoder();
    const decoded = abiCoder.decode(["bytes", "uint256", "uint256"], log.data);
    const [ciphertextBytes, timestamp, nonce] = decoded;
    const topic = log.topics[2];
    const sender = "0x" + log.topics[1].slice(-40);
    const dedupKey = `${address.toLowerCase()}:${generateMessageId(
      log.transactionHash,
      log
    )}`;

    const ciphertextHex = ciphertextBytes as string;
    const ciphertextRaw = hexToUint8Array(ciphertextHex);
    const emitter = emitterAddress || address;
    const isOurMessage = emitter && sender.toLowerCase() === emitter.toLowerCase();

    if (!isOurMessage) {
      const already = await dbService.getByDedupKey(dedupKey);
      if (already) return null;
    }

    onLog(
      `🔍 Processing message log: sender=${sender.slice(
        0,
        8
      )}..., isOurMessage=${isOurMessage}, topic=${topic.slice(
        0,
        10
      )}..., nonce=${Number(nonce)}`
    );

    // =========================================================================
    // OUTGOING MESSAGE CONFIRMATION (Ratchet two-phase commit)
    // =========================================================================
    if (isOurMessage) {
      onLog(
        `🔄 Confirming our outgoing message: topic=${topic.slice(
          0,
          10
        )}..., nonce=${Number(nonce)}`
      );

      // Match by txHash
      const pending = await dbService.getPendingOutboundByTxHash(
        log.transactionHash
      );

      if (pending && pending.status === "submitted") {
        // Finalize: clean up the pending record (session already committed during encryption)
        const finalized = await dbService.finalizePendingOutbound(pending.id);

        if (!finalized) {
          onLog(`⚠️ Failed to finalize pending outbound ${pending.id.slice(0, 8)}...`);
          return null;
        }

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

        onLog(
          `✅ Message confirmed: "${finalized.plaintext.slice(
            0,
            30
          )}..." (${pending.id.slice(0, 8)} → ${newId.slice(0, 8)})`
        );

        return {
          messageUpdate: [pending.id, updates],
        };
      }

      // No matching pending record - this shouldn't happen in normal flow
      onLog(
        `⚠️ Outgoing message on-chain but no pending record found (tx: ${log.transactionHash.slice(0, 10)}...)`
      );
      return null;
    }

    // =========================================================================
    // INCOMING MESSAGE - Use ratchet session for decryption
    // =========================================================================

    // Check session cache FIRST, then fall back to DB
    let session = sessionCache.get(topic);

    if (!session) {
      session =
        (await dbService.getRatchetSessionByTopic(topic)) || undefined;

      if (session) {
        sessionCache.set(topic, session);
      }
    }

    if (!session) {
      onLog(
        `❓ Received message on unknown topic: ${topic.slice(
          0,
          10
        )}... from ${sender.slice(0, 8)}...`
      );
      return null;
    }

    // Find contact for signing key verification
    const contact = await dbService.getContact(session.contactAddress, address);
    if (!contact?.signingPubKey) {
      onLog(
        `✗ No signing key for contact ${session.contactAddress.slice(0, 8)}...`
      );
      return null;
    }

    // Check if ratchet format
    if (!isRatchetPayload(ciphertextRaw)) {
      onLog(
        `✗ Message not in ratchet format from ${contact.address.slice(0, 8)}...`
      );
      return null;
    }

    const parsed = parseRatchetPayload(ciphertextRaw);
    if (!parsed) {
      onLog(
        `✗ Failed to parse ratchet payload from ${contact.address.slice(
          0,
          8
        )}...`
      );
      return null;
    }

    // AUTH-FIRST: Verify signature BEFORE any ratchet operations (DoS protection)
    const sigValid = verifyMessageSignature(
      parsed.signature,
      parsed.header,
      parsed.ciphertext,
      contact.signingPubKey
    );

    if (!sigValid) {
      onLog(
        `✗ Invalid signature on message from ${contact.address.slice(
          0,
          8
        )}..., ignoring`
      );
      return null;
    }

    // decrypt with ratchet (signature verified)
    const decryptResult = ratchetDecrypt(
      session,
      parsed.header,
      parsed.ciphertext
    );

    if (!decryptResult) {
      onLog(
        `✗ Ratchet decryption failed from ${contact.address.slice(0, 8)}...`
      );
      return null;
    }

    // Update session cache IMMEDIATELY
    sessionCache.set(topic, decryptResult.session);

    const decryptedText = new TextDecoder().decode(decryptResult.plaintext);

    const message: Message = {
      id: generateMessageId(log.transactionHash, log),
      topic: topic,
      sender: contact.address,
      recipient: address,
      ciphertext: ciphertextHex,
      timestamp: Number(timestamp) * 1000,
      blockTimestamp: Date.now(),
      blockNumber: log.blockNumber,
      direction: "incoming" as MessageDirection,
      decrypted: decryptedText,
      read: false,
      nonce: Number(nonce),
      dedupKey,
      type: "text" as MessageType,
      ownerAddress: address,
      status: "confirmed",
    };

    const updatedContact: Contact = {
      ...contact,
      lastMessage: decryptedText,
      lastTimestamp: Date.now(),
    };

    // Persist to DB
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

    onLog(
      `📩 Message from ${contact.address.slice(0, 8)}...: "${decryptedText}"`
    );

    return saved
      ? { newMessage: message, contactUpdate: updatedContact }
      : null;
  } catch (error) {
    onLog(`✗ Failed to process message log: ${error}`);
    return null;
  }
}

export async function persistSessionCache(
  sessionCache: Map<string, RatchetSession>,
  onLog: (msg: string) => void
): Promise<void> {
  if (sessionCache.size === 0) return;

  for (const [topic, session] of sessionCache) {
    try {
      await dbService.saveRatchetSession(session);
      onLog(`💾 Persisted session state for topic ${topic.slice(0, 10)}...`);
    } catch (error) {
      onLog(
        `✗ Failed to persist session for topic ${topic.slice(0, 10)}...: ${error}`
      );
    }
  }
}