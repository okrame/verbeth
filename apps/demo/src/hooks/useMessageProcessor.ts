// src/hooks/useMessageProcessor.ts

/**
 * Message Processor Hook.
 * 
 * Manages messaging state (messages, contacts, pendingHandshakes) and
 * orchestrates event processing via EventProcessorService.
 * 
 * Uses VerbethClient for session management and decryption.
 */

import { useState, useEffect, useCallback } from "react";
import type { IdentityContext, IdentityKeyPair, VerbethClient } from "@verbeth/sdk";

import { dbService } from "../services/DbService.js";
import {
  processHandshakeEvent,
  processHandshakeResponseEvent,
  processMessageEvent,
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
  verbethClient: VerbethClient | null;
}

export const useMessageProcessor = ({
  readProvider,
  address,
  emitterAddress,
  identityKeyPair,
  identityContext,
  verbethClient,
}: UseMessageProcessorProps): MessageProcessorResult => {

  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingHandshakes, setPendingHandshakes] = useState<PendingHandshake[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);

  // ===========================================================================
  // Load Data from Database
  // ===========================================================================

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
    } catch (error) {
      console.error(`[verbeth] database load failed:`, error);
    }
  }, [address]);

  // ===========================================================================
  // Event Processing
  // ===========================================================================

  const processEvents = useCallback(
    async (events: ProcessedEvent[]) => {
      if (!address) return;

      for (const event of events) {
        switch (event.eventType) {
          // -----------------------------------------------------------------
          // HANDSHAKE
          // -----------------------------------------------------------------
          case "handshake": {
            if (!verbethClient) {
              throw new Error("message processor is not ready: missing verbethClient");
            }

            const result = await processHandshakeEvent(
              event,
              address,
              readProvider,
              identityContext,
              verbethClient,
            );

            if (result) {
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
          // HANDSHAKE RESPONSE - requires verbethClient for session creation
          // -----------------------------------------------------------------
          case "handshake_response": {
            if (!identityKeyPair || !verbethClient) {
              throw new Error(
                "message processor is not ready: missing identity or verbethClient"
              );
            }

            const result = await processHandshakeResponseEvent(
              event,
              address,
              readProvider,
              identityContext,
              verbethClient,
            );

            if (result) {
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
          // MESSAGE - Uses VerbethClient for decryption
          // -----------------------------------------------------------------
          case "message": {
            if (!verbethClient) {
              throw new Error("message processor is not ready: missing verbethClient");
            }

            const result = await processMessageEvent(
              event,
              address,
              emitterAddress,
              verbethClient,
            );

            if (result) {
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
    },
    [address, readProvider, identityKeyPair, identityContext, emitterAddress, verbethClient]
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
        console.error(`[verbeth] message ${messageId.slice(0, 8)}... failed: ${error}`);
      }
    },
    []
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

  // ===========================================================================
  // Effects
  // ===========================================================================

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
