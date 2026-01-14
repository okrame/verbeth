// src/hooks/useMessageProcessor.ts

/**
 * Manages messaging state (messages, contacts, pendingHandshakes) and
 * orchestrates event processing via EventProcessorService.
 */

import { useState, useEffect, useCallback } from "react";
import { type IdentityContext, type IdentityKeyPair, type RatchetSession } from "@verbeth/sdk";

import { dbService } from "../services/DbService.js";
import {
  processHandshakeEvent,
  processHandshakeResponseEvent,
  processMessageEvent,
  persistSessionCache,
} from "../services/EventProcessorService.js";
import {
  Contact,
  Message,
  PendingHandshake,
  ProcessedEvent,
  MessageProcessorResult,
} from "../types.js";

interface UseMessageProcessorProps {
  readProvider: any;
  address: string | undefined;
  emitterAddress: string | undefined;
  identityKeyPair: IdentityKeyPair | null;
  identityContext: IdentityContext;
  onLog: (message: string) => void;
}

export const useMessageProcessor = ({
  readProvider,
  address,
  emitterAddress,
  identityKeyPair,
  identityContext,
  onLog,
}: UseMessageProcessorProps): MessageProcessorResult => {

  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingHandshakes, setPendingHandshakes] = useState<PendingHandshake[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);

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

      onLog(
        `Loaded from DB for ${address.slice(0, 8)}...: ${dbContacts.length} contacts, ${dbMessages.length} messages, ${dbPendingHandshakes.length} pending handshakes`
      );
    } catch (error) {
      onLog(`✗ Failed to load from database: ${error}`);
    }
  }, [address, onLog]);

  // ===========================================================================
  // Event Processing Orchestration
  // ===========================================================================
  const processEvents = useCallback(
    async (events: ProcessedEvent[]) => {
      if (!address) return;

      // Session cache keyed by conversationId (not topic) for topic ratcheting support
      const batchSessionCache = new Map<string, RatchetSession>();

      const messageEvents = events.filter((e) => e.eventType === "message");
      if (messageEvents.length > 1) {
        onLog(`📨 Processing batch of ${messageEvents.length} messages...`);
      }

      for (const event of events) {
        switch (event.eventType) {
          // -----------------------------------------------------------------
          // HANDSHAKE
          // -----------------------------------------------------------------
          case "handshake": {
            const result = await processHandshakeEvent(
              event,
              address,
              readProvider,
              identityContext,
              onLog
            );

            if (result) {
              // Update React state
              setPendingHandshakes((prev) => {
                const existing = prev.find((h) => h.id === result.pendingHandshake.id);
                if (existing) return prev;
                return [...prev, result.pendingHandshake];
              });
              setMessages((prev) => [...prev, result.systemMessage]);
            }
            break;
          }

          // -----------------------------------------------------------------
          // HANDSHAKE RESPONSE
          // -----------------------------------------------------------------
          case "handshake_response": {
            if (!identityKeyPair) {
              onLog(`❌ Cannot process handshake response: identityKeyPair is null`);
              break;
            }

            const result = await processHandshakeResponseEvent(
              event,
              address,
              readProvider,
              identityKeyPair,
              identityContext,
              onLog
            );

            if (result) {
              // Update React state
              setContacts((prev) =>
                prev.map((c) =>
                  c.address.toLowerCase() === result.updatedContact.address.toLowerCase()
                    ? result.updatedContact
                    : c
                )
              );
              setMessages((prev) => [...prev, result.systemMessage]);
            }
            break;
          }

          // -----------------------------------------------------------------
          // MESSAGE
          // -----------------------------------------------------------------
          case "message": {
            const result = await processMessageEvent(
              event,
              address,
              emitterAddress,
              batchSessionCache,
              onLog
            );

            if (result) {
              // Apply state updates
              if (result.newMessage) {
                setMessages((prev) => {
                  const existing = prev.find((m) => m.id === result.newMessage!.id);
                  if (existing) return prev;
                  return [...prev, result.newMessage!];
                });
              }

              if (result.messageUpdate) {
                const [originalId, updates] = result.messageUpdate;
                setMessages((prev) =>
                  prev.map((m) => (m.id === originalId ? { ...m, ...updates } : m))
                );
              }

              if (result.contactUpdate) {
                setContacts((prev) =>
                  prev.map((c) =>
                    c.address.toLowerCase() === result.contactUpdate!.address.toLowerCase()
                      ? result.contactUpdate!
                      : c
                  )
                );
              }
            }
            break;
          }
        }
      }

      // Persist all updated sessions to DB after batch completes
      await persistSessionCache(batchSessionCache, onLog);
    },
    [address, readProvider, identityKeyPair, identityContext, emitterAddress, onLog]
  );

  // ===========================================================================
  // CRUD Operations
  // ===========================================================================

  const addMessage = useCallback(
    async (message: Message) => {
      if (!address) return;

      const messageWithOwner = { ...message, ownerAddress: address };
      const saved = await dbService.saveMessage(messageWithOwner);
      if (saved) {
        setMessages((prev) => [...prev, messageWithOwner]);
      }
    },
    [address]
  );

  const updateMessageStatus = useCallback(
    async (messageId: string, status: Message["status"], error?: string) => {
      const updates: Partial<Message> = { status };
      await dbService.updateMessage(messageId, updates);

      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, status } : m))
      );

      if (status === "failed" && error) {
        onLog(`✗ Message ${messageId.slice(0, 8)}... failed: ${error}`);
      }
    },
    [onLog]
  );

  const removeMessage = useCallback(async (messageId: string) => {
    await dbService.deleteMessage(messageId);
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }, []);

  const markMessagesLost = useCallback(
  async (contactAddress: string, afterTimestamp: number): Promise<number> => {
    if (!address) return 0;

    const count = await dbService.markMessagesAsLost(address, contactAddress, afterTimestamp);

    if (count > 0) {
      const normalizedContact = contactAddress.toLowerCase();
      setMessages((prev) =>
        prev.map((m) => {
          if (
            m.direction === 'outgoing' &&
            m.recipient?.toLowerCase() === normalizedContact &&
            m.timestamp > afterTimestamp &&
            m.type !== 'system'
          ) {
            return { ...m, isLost: true };
          }
          return m;
        })
      );
    }

    return count;
  },
  [address]
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

  useEffect(() => {
    if (address) {
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
    updateMessageStatus,
    removeMessage,
    removePendingHandshake,
    updateContact,
    processEvents,
    markMessagesLost,
  };
};