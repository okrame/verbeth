// apps/demo/src/hooks/useMessageProcessor.ts

import { useState, useEffect, useCallback, useRef } from "react";
import { AbiCoder, getBytes } from "ethers";
import {
  type IdentityContext,
  parseHandshakePayload,
  parseBindingMessage,
  verifyHandshakeIdentity,
  IdentityKeyPair,
  decodeUnifiedPubKeys,
  verifyAndExtractHandshakeResponseKeys,
  deriveDuplexTopics,
  verifyDerivedDuplexTopics,
  computeTagFromInitiator,
  pickOutboundTopic,
  // Ratchet imports
  initSessionAsInitiator,
  ratchetDecrypt,
  parseRatchetPayload,
  isRatchetPayload,
  verifyMessageSignature,
} from "@verbeth/sdk";

import { dbService } from "../services/DbService.js";
import {
  Contact,
  Message,
  PendingHandshake,
  ProcessedEvent,
  MessageProcessorResult,
  MessageDirection,
  MessageType,
  ContactStatus,
  generateTempMessageId,
} from "../types.js";

interface UseMessageProcessorProps {
  readProvider: any;
  address: string | undefined;
  /** Safe address in fast mode, EOA in classic mode. Used for outbound detection. */
  emitterAddress: string | undefined;
  identityKeyPair: IdentityKeyPair | null;
  identityContext: IdentityContext;
  onLog: (message: string) => void;
}

/**
 * useMessageProcessor
 *
 * - Maintains a FIFO of pending outgoing messages per topic in-memory.
 *   - Enqueue on send (and on DB restore), dequeue on on-chain confirmation.
 *   - This guarantees correct matching when multiple messages are sent before the first confirms.
 *
 * - On confirmation:
 *   1) Prefer the in-memory FIFO (topic -> queue.shift()).
 *   2) If missing (refresh / multi-tab / race), fallback to DB.findPendingMessage(...).
 *   3) If still missing, synthesize a confirmed outgoing from the log (id = txHash-logIndex).
 *
 * - Dedup logic lives in DbService (skip dedup for pending; dedup confirmed by sender:topic:nonce).
 * - NB: listener should query only inbound topics; confirmations are filtered by sender=me.
 */

export const useMessageProcessor = ({
  readProvider,
  address,
  emitterAddress,
  identityKeyPair,
  identityContext,
  onLog,
}: UseMessageProcessorProps): MessageProcessorResult => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingHandshakes, setPendingHandshakes] = useState<
    PendingHandshake[]
  >([]);
  const [contacts, setContacts] = useState<Contact[]>([]);

  // Track pending outgoing per topic in-memory (FIFO queues)
  const pendingMessagesRef = useRef<Map<string, Message[]>>(new Map());

  const hexToUint8Array = (hex: string): Uint8Array => {
    const cleanHex = hex.replace("0x", "");
    return new Uint8Array(
      cleanHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
    );
  };

  const generateMessageId = (
    txHash: string,
    log: { logIndex?: number; index?: number }
  ): string => {
    const idx =
      typeof log.logIndex !== "undefined"
        ? log.logIndex
        : typeof log.index !== "undefined"
        ? log.index
        : 0;
    return `${txHash}-${idx}`;
  };

  const loadFromDatabase = useCallback(async () => {
    if (!address) return;

    try {
      const [dbContacts, dbMessages, dbPendingHandshakes] = await Promise.all([
        dbService.getAllContacts(address),
        dbService.getAllMessages(address, 100),
        dbService.getAllPendingHandshakes(address),
      ]);

      setContacts(dbContacts);
      setMessages(dbMessages);
      setPendingHandshakes(dbPendingHandshakes);

      // Restore pending outgoing messages into the in-memory Map
      pendingMessagesRef.current.clear();
      dbMessages
        .filter(
          (msg) =>
            msg.status === "pending" &&
            msg.direction === "outgoing" &&
            msg.type === "text" &&
            msg.topic
        )
        .forEach((msg) => {
          const q = pendingMessagesRef.current.get(msg.topic) ?? [];
          q.push(msg);
          pendingMessagesRef.current.set(msg.topic, q);
          onLog(
            `Restored pending message for topic ${msg.topic.slice(
              0,
              10
            )}...: "${msg.decrypted?.slice(0, 30)}..."`
          );
        });

      onLog(
        `Loaded from DB for ${address.slice(0, 8)}...: ${
          dbContacts.length
        } contacts, ${dbMessages.length} messages (${
          pendingMessagesRef.current.size
        } pending), ${dbPendingHandshakes.length} pending handshakes`
      );
    } catch (error) {
      onLog(`✗ Failed to load from database: ${error}`);
    }
  }, [address, onLog]);

  const processHandshakeLog = useCallback(
    async (event: ProcessedEvent): Promise<void> => {
      if (!address || !readProvider) return;

      try {
        const log = event.rawLog;
        const abiCoder = new AbiCoder();
        const decoded = abiCoder.decode(["bytes", "bytes", "bytes"], log.data);
        const [
          identityPubKeyBytes,
          ephemeralPubKeyBytes,
          plaintextPayloadBytes,
        ] = decoded;

        const unifiedPubKeys = hexToUint8Array(identityPubKeyBytes);
        const decodedKeys = decodeUnifiedPubKeys(unifiedPubKeys);

        if (!decodedKeys) {
          onLog("✗ Failed to decode unified public keys");
          return;
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

            // Pass identityContext for domain & chain bound verification
            isVerified = await verifyHandshakeIdentity(
              handshakeEvent,
              readProvider,
              identityContext
            );
          } catch (error) {
            onLog(`Failed to verify handshake identity: ${error}`);
          }
        }

        // Extract EOA (identity) from binding message
        let identityAddress = cleanSenderAddress; // fallback to event sender
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

        const pendingHandshake: PendingHandshake = {
          id: log.transactionHash,
          ownerAddress: address,
          sender: identityAddress, // EOA (identity)
          emitterAddress: cleanSenderAddress, // Safe or EOA (event sender)
          identityPubKey,
          signingPubKey,
          ephemeralPubKey,
          message: handshakeContent.plaintextPayload,
          timestamp: Date.now(),
          blockNumber: log.blockNumber,
          verified: isVerified,
        };

        await dbService.savePendingHandshake(pendingHandshake);

        setPendingHandshakes((prev) => {
          const existing = prev.find((h) => h.id === pendingHandshake.id);
          if (existing) return prev;
          return [...prev, pendingHandshake];
        });

        const handshakeMessage: Message = {
          id: generateTempMessageId(),
          topic: "",
          sender: identityAddress,
          recipient: address,
          ciphertext: "",
          timestamp: Date.now(),
          blockTimestamp: Date.now(),
          blockNumber: log.blockNumber,
          direction: "incoming" as const,
          decrypted: `Request received: "${handshakeContent.plaintextPayload}"`,
          read: true,
          nonce: 0,
          dedupKey: `handshake-received-${log.transactionHash}`,
          type: "system" as const,
          ownerAddress: address,
          status: "confirmed" as const,
          verified: isVerified,
        };

        await dbService.saveMessage(handshakeMessage);
        setMessages((prev) => [...prev, handshakeMessage]);

        onLog(
          `📨 Handshake received from ${identityAddress.slice(0, 8)}... ${
            isVerified ? "✅" : "⚠️"
          }: "${handshakeContent.plaintextPayload}"`
        );
      } catch (error) {
        onLog(`✗ Failed to process handshake log: ${error}`);
      }
    },
    [address, readProvider, identityContext, onLog]
  );

  const processHandshakeResponseLog = useCallback(
    async (event: ProcessedEvent): Promise<void> => {
      if (!address || !readProvider) return;

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

        // Use matchedContactAddress from listener (tag-based matching)
        // This works regardless of whether responder is EOA or Safe
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
          return;
        }

        const responseEvent = {
          inResponseTo,
          responder,
          responderEphemeralR: responderEphemeralRBytes,
          ciphertext: ciphertextJson,
        };

        // Pass identityContext for domain & chain bound verification
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
          return;
        }

        const { identityPubKey, signingPubKey, ephemeralPubKey, note } =
          result.keys;

        if (!identityKeyPair) {
          onLog(`❌ Cannot verify duplex topics: identityKeyPair is null`);
          return;
        }

        const saltHex = computeTagFromInitiator(
          getBytes(contact.handshakeEphemeralSecret!), // Alice's ephemeral secret (hex → Uint8Array)
          hexToUint8Array(responderEphemeralRBytes)    // Bob's public R from the response event
        );
        const salt = Uint8Array.from(Buffer.from(saltHex.slice(2), "hex"));

        const duplexTopics = deriveDuplexTopics(
          identityKeyPair.secretKey, // Alice's identity secret key
          identityPubKey, // Bob's identity public key (from response)
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
            `❌ Invalid duplex topics checksum for ${contact.address.slice(
              0,
              8
            )}...`
          );
          return;
        }

        onLog(
          `✅ Handshake response verified from ${contact.address.slice(
            0,
            8
          )}...`
        );

        // Determine topics from initiator's perspective
        const topicOutbound = pickOutboundTopic(true, duplexTopics); // Alice is initiator
        const topicInbound = pickOutboundTopic(false, duplexTopics); // Bob is responder

        // =====================================================================
        // RATCHET: Initialize session as INITIATOR
        // CRITICAL: Use ephemeralPubKey from INSIDE the decrypted payload,
        // NOT the on-chain responderEphemeralR (which is only for tag verification).
        // This separation provides unlinkability between handshake and conversation.
        // =====================================================================
        const ratchetSession = initSessionAsInitiator({
          myAddress: address,
          contactAddress: contact.address,
          myHandshakeEphemeralSecret: getBytes(contact.handshakeEphemeralSecret!),
          theirResponderEphemeralPubKey: ephemeralPubKey, // From decrypted payload!
          topicOutbound,
          topicInbound,
        });

        // Save ratchet session
        await dbService.saveRatchetSession(ratchetSession);

        const updatedContact: Contact = {
          ...contact,
          status: "established" as ContactStatus,
          identityPubKey,
          signingPubKey,
          handshakeEphemeralSecret: undefined, // Clear ephemeral secret (no longer needed)
          topicOutbound,
          topicInbound,
          conversationId: ratchetSession.conversationId,
          lastMessage: note || "Handshake accepted",
          lastTimestamp: Date.now(),
        };

        await dbService.saveContact(updatedContact);

        // Use contact.address (the EOA we initiated to), not responder (could be Safe)
        setContacts((prev) =>
          prev.map((c) =>
            c.address.toLowerCase() === contact.address.toLowerCase()
              ? updatedContact
              : c
          )
        );

        onLog(
          `🤝 Handshake completed with ${contact.address.slice(0, 8)}... : "${
            note || "No message"
          }"`
        );

        const responseMessage: Message = {
          id: generateTempMessageId(),
          topic: updatedContact.topicInbound || "",
          sender: contact.address, // Use contact address, not responder
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

        await dbService.saveMessage(responseMessage);
        setMessages((prev) => [...prev, responseMessage]);
      } catch (error) {
        onLog(`✗ Failed to process handshake response log: ${error}`);
      }
    },
    [address, readProvider, identityKeyPair, identityContext, onLog]
  );

  const processMessageLog = useCallback(
    async (event: ProcessedEvent): Promise<void> => {
      if (!address || !identityKeyPair) return;

      try {
        const log = event.rawLog;
        const abiCoder = new AbiCoder();
        const decoded = abiCoder.decode(
          ["bytes", "uint256", "uint256"],
          log.data
        );
        const [ciphertextBytes, timestamp, nonce] = decoded;
        const topic = log.topics[2];
        const sender = "0x" + log.topics[1].slice(-40);
        const key = `${address.toLowerCase()}:${generateMessageId(
          log.transactionHash,
          log
        )}`;

        // Raw ciphertext bytes (could be ratchet binary or legacy JSON)
        const ciphertextHex = ciphertextBytes as string;
        const ciphertextRaw = hexToUint8Array(ciphertextHex);
        // Use emitterAddress (Safe in fast mode) for outbound detection
        const emitter = emitterAddress || address;
        const isOurMessage =
          emitter && sender.toLowerCase() === emitter.toLowerCase();

        if (!isOurMessage) {
          const already = await dbService.getByDedupKey(key);
          if (already) return;
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

        // OUTGOING MESSAGE CONFIRMATION
        if (isOurMessage) {
          onLog(
            `🔄 Confirming our outgoing message: topic=${topic.slice(
              0,
              10
            )}..., nonce=${Number(nonce)}`
          );

          // =====================================================================
          // RATCHET TWO-PHASE COMMIT: Match by txHash (primary method)
          // =====================================================================
          const pending = await dbService.getPendingOutboundByTxHash(log.transactionHash);

          if (pending && pending.status === "submitted") {
            // Commit the session state (applies sessionStateAfter)
            await dbService.commitPendingOutbound(pending.id);

            // Update message status from pending to confirmed
            const newId = generateMessageId(log.transactionHash, log);
            await dbService.updateMessage(pending.id, {
              id: newId,
              status: "confirmed",
              blockNumber: log.blockNumber,
              blockTimestamp: Date.now(),
              ciphertext: ciphertextHex,
              nonce: Number(nonce),
              dedupKey: key,
            });

            await dbService.upsertDedup({
              key,
              messageId: newId,
              txHash: log.transactionHash,
              blockNumber: log.blockNumber,
            });

            setMessages((prev) =>
              prev.map((m) =>
                m.id === pending.id
                  ? { ...m, id: newId, status: "confirmed", blockNumber: log.blockNumber }
                  : m
              )
            );

            onLog(
              `✅ Message confirmed: "${pending.plaintext.slice(0, 30)}..." (${pending.id.slice(0, 8)} → ${newId.slice(0, 8)})`
            );
            return;
          }

          // =====================================================================
          // LEGACY FALLBACK: In-memory FIFO matching (for non-ratchet messages)
          // =====================================================================
          const q = pendingMessagesRef.current.get(topic) ?? [];
          const pendingMessage = q.shift();
          pendingMessagesRef.current.set(topic, q);

          if (pendingMessage) {
            onLog(
              `Matched pending by topic (legacy). Content preview: "${pendingMessage.decrypted?.slice(
                0,
                100
              )}..."`
            );

            const newId = generateMessageId(log.transactionHash, log);
            const confirmedMessage: Message = {
              ...pendingMessage,
              id: newId,
              blockNumber: log.blockNumber,
              blockTimestamp: Date.now(),
              ciphertext: ciphertextHex,
              nonce: Number(nonce),
              dedupKey: key,
              status: "confirmed",
            };

            if (q.length === 0) {
              pendingMessagesRef.current.delete(topic);
            }

            await dbService.updateMessage(pendingMessage.id, confirmedMessage);
            await dbService.upsertDedup({
              key,
              messageId: newId,
              txHash: log.transactionHash,
              blockNumber: log.blockNumber,
            });

            setMessages((prev) =>
              prev.map((m) =>
                m.id === pendingMessage.id ? confirmedMessage : m
              )
            );

            onLog(
              `✅ Outgoing message confirmed: "${pendingMessage.decrypted?.slice(
                0,
                30
              )}..." (${pendingMessage.id} → ${newId})`
            );
          } else {
            // DB fallback for multi-tab / refresh scenarios
            const dbFallback = await dbService.findPendingMessage(
              address,
              topic,
              Number(nonce),
              address
            );

            const allContacts = await dbService.getAllContacts(address);
            const byTopic = allContacts.find((c) => c.topicOutbound === topic);

            const newId = generateMessageId(log.transactionHash, log);
            const confirmed: Message = {
              id: newId,
              topic,
              sender: address,
              recipient: byTopic?.address,
              ciphertext: ciphertextHex,
              timestamp: Number(timestamp) * 1000,
              blockTimestamp: Date.now(),
              blockNumber: log.blockNumber,
              direction: "outgoing",
              read: true,
              decrypted: dbFallback?.decrypted,
              type: "text",
              nonce: Number(nonce),
              dedupKey: key,
              ownerAddress: address,
              status: "confirmed",
            };

            if (dbFallback) {
              await dbService.updateMessage(dbFallback.id, confirmed);
              await dbService.upsertDedup({
                key,
                messageId: newId,
                txHash: log.transactionHash,
                blockNumber: log.blockNumber,
              });
              setMessages((prev) =>
                prev.map((m) => (m.id === dbFallback.id ? confirmed : m))
              );
              onLog(
                `✅ Outgoing message confirmed (fallback): "${
                  confirmed.decrypted?.slice(0, 30) ?? ""
                }" (${dbFallback.id} → ${newId})`
              );
            } else {
              await dbService.saveMessage(confirmed);
              await dbService.upsertDedup({
                key,
                messageId: newId,
                txHash: log.transactionHash,
                blockNumber: log.blockNumber,
              });
              setMessages((prev) => [...prev, confirmed]);
              onLog(`✅ Outgoing message confirmed (synthesized): ${newId}`);
            }
          }

          return;
        }

// =====================================================================
        // INCOMING MESSAGE - Use ratchet session for decryption
        // =====================================================================
        
        // Try to find ratchet session by inbound topic
        const session = await dbService.getRatchetSessionByTopic(topic);
        
        if (!session) {
          onLog(
            `❓ Received message on unknown topic: ${topic.slice(0, 10)}... from ${sender.slice(0, 8)}...`
          );
          return;
        }

        // Find contact for signing key verification
        const contact = await dbService.getContact(session.contactAddress, address);
        if (!contact?.signingPubKey) {
          onLog(`✗ No signing key for contact ${session.contactAddress.slice(0, 8)}...`);
          return;
        }

        // Check if ratchet format
        if (!isRatchetPayload(ciphertextRaw)) {
          onLog(`✗ Message not in ratchet format from ${contact.address.slice(0, 8)}...`);
          return;
        }

        const parsed = parseRatchetPayload(ciphertextRaw);
        if (!parsed) {
          onLog(`✗ Failed to parse ratchet payload from ${contact.address.slice(0, 8)}...`);
          return;
        }

        // =====================================================================
        // AUTH-FIRST: Verify signature BEFORE any ratchet operations (DoS protection)
        // =====================================================================
        const sigValid = verifyMessageSignature(
          parsed.signature,
          parsed.header,
          parsed.ciphertext,
          contact.signingPubKey
        );

        if (!sigValid) {
          onLog(`✗ Invalid signature on message from ${contact.address.slice(0, 8)}..., ignoring`);
          return;
        }

        // =====================================================================
        // DECRYPT with ratchet (signature verified, safe to proceed)
        // =====================================================================
        const decryptResult = ratchetDecrypt(session, parsed.header, parsed.ciphertext);

        if (!decryptResult) {
          onLog(`✗ Ratchet decryption failed from ${contact.address.slice(0, 8)}...`);
          return;
        }

        // Commit new session state immediately (receiving is safe to commit)
        await dbService.saveRatchetSession(decryptResult.session);

        // Decode plaintext
        const decryptedText = new TextDecoder().decode(decryptResult.plaintext);

        const message: Message = {
          id: generateMessageId(log.transactionHash, log),
          topic: topic,
          sender: contact.address, // Use contact address, not on-chain sender
          recipient: address,
          ciphertext: ciphertextHex,
          timestamp: Number(timestamp) * 1000,
          blockTimestamp: Date.now(),
          blockNumber: log.blockNumber,
          direction: "incoming" as MessageDirection,
          decrypted: decryptedText,
          read: false,
          nonce: Number(nonce),
          dedupKey: key,
          type: "text" as MessageType,
          ownerAddress: address,
          status: "confirmed",
        };

        const saved = await dbService.saveMessage(message);

        if (saved) {
          await dbService.upsertDedup({
            key,
            messageId: message.id,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
          });
          setMessages((prev) => {
            const existing = prev.find((m) => m.id === message.id);
            if (existing) return prev;
            return [...prev, message];
          });

          const updatedContact: Contact = {
            ...contact,
            lastMessage: decryptedText,
            lastTimestamp: Date.now(),
          };

          await dbService.saveContact(updatedContact);

          setContacts((prev) =>
            prev.map((c) =>
              c.address.toLowerCase() === contact.address.toLowerCase()
                ? updatedContact
                : c
            )
          );

          onLog(`📩 Message from ${contact.address.slice(0, 8)}...: "${decryptedText}"`);
        }
      } catch (error) {
        onLog(`✗ Failed to process message log: ${error}`);
      }
    },
    [address, emitterAddress, identityKeyPair, onLog]
  );

  const processEvents = useCallback(
    async (events: ProcessedEvent[]) => {
      for (const event of events) {
        switch (event.eventType) {
          case "handshake":
            await processHandshakeLog(event);
            break;
          case "handshake_response":
            await processHandshakeResponseLog(event);
            break;
          case "message":
            await processMessageLog(event);
            break;
        }
      }
    },
    [processHandshakeLog, processHandshakeResponseLog, processMessageLog]
  );

  const addMessage = useCallback(
    async (message: Message) => {
      if (!address) return;

      const messageWithOwner = { ...message, ownerAddress: address };
      // Track pending outgoing in the in-memory Map
      if (
        messageWithOwner.status === "pending" &&
        messageWithOwner.direction === "outgoing" &&
        messageWithOwner.type === "text" &&
        messageWithOwner.topic
      ) {
        const q = pendingMessagesRef.current.get(messageWithOwner.topic) ?? [];
        q.push(messageWithOwner);
        pendingMessagesRef.current.set(messageWithOwner.topic, q);
        onLog(
          `Registered pending message for topic ${messageWithOwner.topic.slice(
            0,
            10
          )}...`
        );
      }

      const saved = await dbService.saveMessage(messageWithOwner);
      if (saved) {
        setMessages((prev) => [...prev, messageWithOwner]);
      }
    },
    [address, onLog]
  );

  const removePendingHandshake = useCallback(async (id: string) => {
    await dbService.deletePendingHandshake(id);
    setPendingHandshakes((prev) => prev.filter((h) => h.id !== id));
  }, []);

  const updateContact = useCallback(
    async (contact: Contact) => {
      if (!address) return;
      const contactWithOwner = { ...contact, ownerAddress: address };
      await dbService.saveContact(contactWithOwner);

      const allContacts = await dbService.getAllContacts(address);
      setContacts(allContacts);
    },
    [address]
  );

  // cleanup and reload when address changes
  useEffect(() => {
    if (address) {
      pendingMessagesRef.current.clear();
      setMessages([]);
      setContacts([]);
      setPendingHandshakes([]);
      loadFromDatabase();
    }
  }, [address, loadFromDatabase]);

  return {
    messages,
    pendingHandshakes,
    contacts,
    addMessage,
    removePendingHandshake,
    updateContact,
    processEvents,
  };
};
