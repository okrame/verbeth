// src/hooks/useChatActions.ts

/**
 * Chat actions hook with Double Ratchet integration.
 * 
 * Key changes from legacy:
 * - acceptHandshake now creates ratchet session
 * - sendMessageToContact uses ratchet encryption with two-phase commit
 * - Sequential blocking: only one pending message per conversation
 */

import { useCallback } from "react";
import { hexlify } from "ethers";
import {
  pickOutboundTopic,
  VerbethClient,
  // Ratchet imports
  initSessionAsResponder,
  ratchetEncrypt,
  packageRatchetPayload,
} from "@verbeth/sdk";
import { dbService } from "../services/DbService.js";
import {
  Contact,
  PendingOutbound,
  generateTempMessageId,
  serializeRatchetSession,
} from "../types.js";

interface UseChatActionsProps {
  verbethClient: VerbethClient | null;
  addLog: (message: string) => void;
  updateContact: (contact: Contact) => Promise<void>;
  addMessage: (message: any) => Promise<void>;
  removePendingHandshake: (id: string) => Promise<void>;
  setSelectedContact: (contact: Contact | null) => void;
  setLoading: (loading: boolean) => void;
  setMessage: (message: string) => void;
  setRecipientAddress: (address: string) => void;
}

export const useChatActions = ({
  verbethClient,
  addLog,
  updateContact,
  addMessage,
  removePendingHandshake,
  setSelectedContact,
  setLoading,
  setMessage,
  setRecipientAddress,
}: UseChatActionsProps) => {

  /**
   * Send a handshake to initiate contact.
   * Stores ephemeral secret for ratchet session init when response arrives.
   */
  const sendHandshake = useCallback(
    async (recipientAddress: string, message: string) => {
      if (!verbethClient) {
        addLog("✗ Client not initialized");
        return;
      }

      if (!recipientAddress || !message) {
        addLog("✗ Missing recipient address or message");
        return;
      }

      setLoading(true);
      try {
        const { tx, ephemeralKeyPair } = await verbethClient.sendHandshake(
          recipientAddress,
          message
        );

        // Store ephemeral secret for ratchet session init when response arrives
        const newContact: Contact = {
          address: recipientAddress,
          ownerAddress: verbethClient.userAddress,
          status: "handshake_sent",
          // Store ephemeral secret (hex) for later use in initSessionAsInitiator
          handshakeEphemeralSecret: hexlify(ephemeralKeyPair.secretKey),
          lastMessage: message,
          lastTimestamp: Date.now(),
        };

        await updateContact(newContact);
        setSelectedContact(newContact);

        const handshakeMessage = {
          id: generateTempMessageId(),
          topic: "",
          sender: verbethClient.userAddress,
          recipient: recipientAddress,
          ciphertext: "",
          timestamp: Date.now(),
          blockTimestamp: Date.now(),
          blockNumber: 0,
          direction: "outgoing" as const,
          decrypted: `Request sent: "${message}"`,
          read: true,
          nonce: 0,
          dedupKey: `handshake-${tx.hash}`,
          type: "system" as const,
          ownerAddress: verbethClient.userAddress,
          status: "pending" as const,
        };

        await addMessage(handshakeMessage);

        addLog(
          `Handshake sent to ${recipientAddress.slice(0, 8)}...: "${message}" (tx: ${tx.hash})`
        );
        setMessage("");
        setRecipientAddress("");
      } catch (error) {
        console.error("Failed to send handshake:", error);
        addLog(
          `✗ Failed to send handshake: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      } finally {
        setLoading(false);
      }
    },
    [
      verbethClient,
      addLog,
      updateContact,
      addMessage,
      setSelectedContact,
      setLoading,
      setMessage,
      setRecipientAddress,
    ]
  );

  /**
   * Accept a handshake and create ratchet session.
   * This is where the responder's ratchet session is initialized.
   */
  const acceptHandshake = useCallback(
    async (handshake: any, responseMessage: string) => {
      if (!verbethClient) {
        addLog("✗ Client not initialized");
        return;
      }

      try {
        // Accept handshake - now returns ephemeral keys for ratchet
        const {
          tx,
          duplexTopics,
          responderEphemeralSecret,
          responderEphemeralPublic,
        } = await verbethClient.acceptHandshake(
          handshake.ephemeralPubKey,
          handshake.identityPubKey,
          responseMessage
        );

        // Determine topics from responder's perspective
        const topicOutbound = pickOutboundTopic(false, duplexTopics); // Responder
        const topicInbound = pickOutboundTopic(true, duplexTopics);   // Responder

        // Initialize ratchet session as responder
        const ratchetSession = initSessionAsResponder({
          myAddress: verbethClient.userAddress,
          contactAddress: handshake.sender,
          myResponderEphemeralSecret: responderEphemeralSecret,
          myResponderEphemeralPublic: responderEphemeralPublic,
          theirHandshakeEphemeralPubKey: handshake.ephemeralPubKey,
          topicOutbound,
          topicInbound,
        });

        // Save ratchet session
        await dbService.saveRatchetSession(ratchetSession);

        // Update contact with session info
        const newContact: Contact = {
          address: handshake.sender,
          ownerAddress: verbethClient.userAddress,
          status: "established",
          identityPubKey: handshake.identityPubKey,
          signingPubKey: handshake.signingPubKey,
          topicOutbound,
          topicInbound,
          conversationId: ratchetSession.conversationId,
          lastMessage: responseMessage,
          lastTimestamp: Date.now(),
        };

        await updateContact(newContact);
        await removePendingHandshake(handshake.id);
        setSelectedContact(newContact);

        const acceptanceMessage = {
          id: generateTempMessageId(),
          topic: topicOutbound,
          sender: verbethClient.userAddress,
          recipient: handshake.sender,
          ciphertext: "",
          timestamp: Date.now(),
          blockTimestamp: Date.now(),
          blockNumber: 0,
          direction: "outgoing" as const,
          decrypted: `Request accepted: "${responseMessage}"`,
          read: true,
          nonce: 0,
          dedupKey: `handshake-accepted-${handshake.id}`,
          type: "system" as const,
          ownerAddress: verbethClient.userAddress,
          status: "pending" as const,
        };

        await addMessage(acceptanceMessage);

        addLog(
          `✅ Handshake accepted from ${handshake.sender.slice(0, 8)}... - ratchet session created`
        );
      } catch (error) {
        console.error("Failed to accept handshake:", error);
        addLog(
          `✗ Failed to accept handshake: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    },
    [
      verbethClient,
      addLog,
      updateContact,
      removePendingHandshake,
      addMessage,
      setSelectedContact,
    ]
  );

  /**
   * Send an encrypted message using Double Ratchet.
   * Implements two-phase commit with sequential blocking.
   */
  const sendMessageToContact = useCallback(
    async (contact: Contact, messageText: string) => {
      if (!verbethClient) {
        addLog("✗ Client not initialized");
        return;
      }

      if (!contact.conversationId) {
        addLog("✗ Contact doesn't have a ratchet session");
        return;
      }

      // 1. SEQUENTIAL BLOCKING: Check for existing pending outbound
      const existingPending = await dbService.getPendingOutboundByConversation(
        contact.conversationId
      );
      if (existingPending.length > 0) {
        addLog("⏳ Please wait for previous message to confirm before sending another");
        return;
      }

      setLoading(true);
      const pendingId = generateTempMessageId();

      try {
        // 2. Load ratchet session
        const session = await dbService.getRatchetSessionByConversation(
          contact.conversationId
        );
        if (!session) {
          addLog("✗ No ratchet session for this contact");
          setLoading(false);
          return;
        }

        // 3. Encrypt with ratchet (returns new session state, doesn't mutate)
        const plaintext = new TextEncoder().encode(messageText);
        const { session: nextSession, header, ciphertext, signature } = ratchetEncrypt(
          session,
          plaintext,
          verbethClient.identityKeyPairInstance.signingSecretKey
        );

        // 4. Package binary payload
        const payload = packageRatchetPayload(signature, header, ciphertext);
        const payloadHex = hexlify(payload);

        // 5. Create pending record (two-phase commit)
        const pending: PendingOutbound = {
          id: pendingId,
          conversationId: session.conversationId,
          topic: session.topicOutbound,
          payloadHex,
          plaintext: messageText,
          sessionStateBefore: JSON.stringify(serializeRatchetSession(session)),
          sessionStateAfter: JSON.stringify(serializeRatchetSession(nextSession)),
          createdAt: Date.now(),
          txHash: null,
          status: "preparing",
        };
        await dbService.savePendingOutbound(pending);

        // 6. Add optimistic UI message
        await addMessage({
          id: pendingId,
          topic: session.topicOutbound,
          sender: verbethClient.userAddress,
          recipient: contact.address,
          ciphertext: "",
          timestamp: Date.now(),
          blockTimestamp: Date.now(),
          blockNumber: 0,
          direction: "outgoing" as const,
          decrypted: messageText,
          read: true,
          nonce: nextSession.sendingMsgNumber - 1,
          dedupKey: `pending-${pendingId}`,
          type: "text" as const,
          ownerAddress: verbethClient.userAddress,
          status: "pending" as const,
        });

        // 7. Send transaction
        const timestamp = Math.floor(Date.now() / 1000);
        const nonce = nextSession.sendingMsgNumber - 1;

        await dbService.updatePendingOutboundStatus(pendingId, "submitted");

        // Send the binary payload as bytes
        // The executor.sendMessage expects: (payload: Uint8Array | bytes, topic, timestamp, nonce)
        const tx = await verbethClient.executorInstance.sendMessage(
          payload,                           // Raw binary payload
          session.topicOutbound,             // Topic (bytes32 hex)
          timestamp,                         // Unix timestamp
          BigInt(nonce)                      // Convert to bigint
        );

        // Update with txHash for confirmation matching
        await dbService.updatePendingOutboundStatus(pendingId, "submitted", tx.hash);

        addLog(
          `Message sent to ${contact.address.slice(0, 8)}...: "${messageText}" (tx: ${tx.hash})`
        );

        // Update contact last message
        const updatedContact: Contact = {
          ...contact,
          lastMessage: messageText,
          lastTimestamp: Date.now(),
        };
        await updateContact(updatedContact);

        // Note: Actual session state commit happens in useMessageProcessor
        // when we see the on-chain confirmation

      } catch (error) {
        console.error("Failed to send message:", error);

        // Rollback: delete pending record, keep old session state
        try {
          await dbService.deletePendingOutbound(pendingId);
        } catch (cleanupError) {
          console.error("Failed to cleanup pending outbound:", cleanupError);
        }
        
        try {
          await dbService.updateMessage(pendingId, { status: "failed" });
        } catch (updateError) {
          console.error("Failed to mark message as failed:", updateError);
        }

        addLog(
          `✗ Failed to send message: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      } finally {
        setLoading(false);
      }
    },
    [
      verbethClient,
      addLog,
      addMessage,
      updateContact,
      setLoading,
    ]
  );

  return {
    sendHandshake,
    acceptHandshake,
    sendMessageToContact,
  };
};