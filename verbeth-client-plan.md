# VerbethClient SDK Improvements: Implementation Guide

## Executive Summary

This document provides concrete implementation details for the VerbethClient improvement plan. The changes centralize session management into the SDK while allowing apps to provide their own storage adapters.

---

## Current Pain Points (from codebase analysis)

| Problem | Where it occurs |
|---------|-----------------|
| Session lookup logic duplicated | `RatchetDbService.getRatchetSessionByAnyInboundTopic()`, `EventProcessorService.processMessageEvent()` |
| Two-phase commit scattered | `useMessageQueue.ts` lines 139-254 |
| Session cache managed by app | `useMessageQueue.ts` line 77-78, `EventProcessorService.ts` line 539-569 |
| Pending outbound tracking manual | `useMessageQueue.ts` lines 170-182 |
| Topic promotion duplicated | `EventProcessorService.ts` lines 543-569 |

---

## Milestone 1: Session Store Interface + Encrypt/Decrypt Helpers

### 1.1 New SDK Types

**File: `packages/sdk/src/client/types.ts`**

```typescript
import { RatchetSession, MessageHeader, EncryptResult } from '../ratchet/types.js';

/**
 * Storage interface for ratchet sessions.
 * Implement this to connect VerbethClient to your storage layer.
 */
export interface SessionStore {
  /**
   * Get session by conversation ID (primary key).
   */
  get(conversationId: string): Promise<RatchetSession | null>;

  /**
   * Find session by any active inbound topic.
   * Must check: currentTopicInbound, nextTopicInbound, previousTopicInbound (if not expired).
   */
  getByInboundTopic(topic: string): Promise<RatchetSession | null>;

  /**
   * Persist session state.
   * Called after encrypt (immediate commit) and after decrypt.
   */
  save(session: RatchetSession): Promise<void>;
}

/**
 * Result of prepareMessage - contains everything needed to send and commit.
 */
export interface PreparedMessage {
  /** Unique ID for this prepared message */
  id: string;
  /** Conversation this message belongs to */
  conversationId: string;
  /** Topic to publish to (may be ratcheted) */
  topic: `0x${string}`;
  /** Binary payload ready for on-chain submission */
  payload: Uint8Array;
  /** Original plaintext (for UI/storage) */
  plaintext: string;
  /** Session state BEFORE encryption (for rollback if needed) */
  sessionBefore: RatchetSession;
  /** Session state AFTER encryption (to persist on commit) */
  sessionAfter: RatchetSession;
  /** Message number in the sending chain */
  messageNumber: number;
  /** Timestamp when prepared */
  createdAt: number;
}

/**
 * Result of decryptMessage.
 */
export interface DecryptedMessage {
  /** Conversation ID */
  conversationId: string;
  /** Decrypted plaintext */
  plaintext: string;
  /** Whether this was our own message (echo) */
  isOwnMessage: boolean;
  /** Updated session state (must be persisted) */
  session: RatchetSession;
  /** Topic the message arrived on */
  topic: string;
  /** Which topic matched: 'current', 'next', or 'previous' */
  topicMatch: 'current' | 'next' | 'previous';
}
```

### 1.2 Session Manager (Internal)

**File: `packages/sdk/src/client/SessionManager.ts`**

```typescript
import { RatchetSession, TOPIC_TRANSITION_WINDOW_MS } from '../ratchet/types.js';
import { SessionStore } from './types.js';

/**
 * Internal session coordinator.
 * Handles topic matching, session lookup, and topic promotion.
 */
export class SessionManager {
  private cache = new Map<string, RatchetSession>();
  
  constructor(private store: SessionStore) {}

  /**
   * Get session by conversation ID, checking cache first.
   */
  async getByConversationId(conversationId: string): Promise<RatchetSession | null> {
    // Check cache first
    const cached = this.cache.get(conversationId);
    if (cached) return cached;

    // Load from store
    const session = await this.store.get(conversationId);
    if (session) {
      this.cache.set(conversationId, session);
    }
    return session;
  }

  /**
   * Find session by inbound topic with automatic topic promotion.
   */
  async getByInboundTopic(topic: string): Promise<{
    session: RatchetSession;
    topicMatch: 'current' | 'next' | 'previous';
  } | null> {
    const topicLower = topic.toLowerCase();
    
    // Try store's topic lookup
    const session = await this.store.getByInboundTopic(topic);
    if (!session) return null;

    // Check cache for more recent state
    const cached = this.cache.get(session.conversationId);
    let workingSession = cached || session;

    // Determine which topic matched and handle promotion
    if (workingSession.currentTopicInbound.toLowerCase() === topicLower) {
      return { session: workingSession, topicMatch: 'current' };
    }

    if (workingSession.nextTopicInbound?.toLowerCase() === topicLower) {
      // Promote next topics to current
      workingSession = this.promoteTopics(workingSession);
      this.cache.set(workingSession.conversationId, workingSession);
      return { session: workingSession, topicMatch: 'next' };
    }

    if (
      workingSession.previousTopicInbound?.toLowerCase() === topicLower &&
      workingSession.previousTopicExpiry &&
      Date.now() < workingSession.previousTopicExpiry
    ) {
      return { session: workingSession, topicMatch: 'previous' };
    }

    return null;
  }

  /**
   * Update session in cache and persist to store.
   */
  async save(session: RatchetSession): Promise<void> {
    this.cache.set(session.conversationId, session);
    await this.store.save(session);
  }

  /**
   * Update cache without persisting (for batch operations).
   */
  updateCache(session: RatchetSession): void {
    this.cache.set(session.conversationId, session);
  }

  /**
   * Invalidate cache entry (e.g., on session reset).
   */
  invalidate(conversationId: string): void {
    this.cache.delete(conversationId);
  }

  /**
   * Clear entire cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Promote next topics to current (internal helper).
   */
  private promoteTopics(session: RatchetSession): RatchetSession {
    if (!session.nextTopicInbound || !session.nextTopicOutbound) {
      return session;
    }

    return {
      ...session,
      previousTopicInbound: session.currentTopicInbound,
      previousTopicExpiry: Date.now() + TOPIC_TRANSITION_WINDOW_MS,
      currentTopicInbound: session.nextTopicInbound,
      currentTopicOutbound: session.nextTopicOutbound,
      nextTopicInbound: undefined,
      nextTopicOutbound: undefined,
      topicEpoch: session.topicEpoch + 1,
      updatedAt: Date.now(),
    };
  }
}
```

### 1.3 VerbethClient Extensions

**File: `packages/sdk/src/client/VerbethClient.ts`** (additions to existing class)

```typescript
import { hexlify } from 'ethers';
import { ratchetEncrypt, packageRatchetPayload } from '../ratchet/index.js';
import { ratchetDecrypt, parseRatchetPayload, isRatchetPayload } from '../ratchet/decrypt.js';
import { verifyMessageSignature } from '../ratchet/auth.js';
import { SessionStore, PreparedMessage, DecryptedMessage } from './types.js';
import { SessionManager } from './SessionManager.js';

// Add to VerbethClient class:

export class VerbethClient {
  // ... existing properties ...
  
  private sessionManager?: SessionManager;

  /**
   * Configure session storage.
   * Must be called before using prepareMessage/decryptMessage.
   */
  setSessionStore(store: SessionStore): void {
    this.sessionManager = new SessionManager(store);
  }

  /**
   * Prepare a message for sending (encrypt without persisting).
   * 
   * Two-phase commit pattern:
   * 1. prepareMessage() - encrypts and returns PreparedMessage
   * 2. Send transaction using prepared.payload and prepared.topic
   * 3. commitMessage() - persists session state after tx confirmation
   * 
   * Session state is committed immediately for forward secrecy.
   * If tx fails, the ratchet slot is "burned" (receiver handles via skip keys).
   */
  async prepareMessage(
    conversationId: string,
    plaintext: string
  ): Promise<PreparedMessage> {
    if (!this.sessionManager) {
      throw new Error('SessionStore not configured. Call setSessionStore() first.');
    }

    const session = await this.sessionManager.getByConversationId(conversationId);
    if (!session) {
      throw new Error(`No session found for conversation: ${conversationId}`);
    }

    const plaintextBytes = new TextEncoder().encode(plaintext);
    
    const encryptResult = ratchetEncrypt(
      session,
      plaintextBytes,
      this.identityKeyPairInstance.signingSecretKey
    );

    const payload = packageRatchetPayload(
      encryptResult.signature,
      encryptResult.header,
      encryptResult.ciphertext
    );

    // Immediately persist session state (forward secrecy)
    await this.sessionManager.save(encryptResult.session);

    const prepared: PreparedMessage = {
      id: `prep-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      conversationId,
      topic: encryptResult.topic,
      payload,
      plaintext,
      sessionBefore: session,
      sessionAfter: encryptResult.session,
      messageNumber: session.sendingMsgNumber,
      createdAt: Date.now(),
    };

    return prepared;
  }

  /**
   * Commit a prepared message after successful tx.
   * In the current design, session is already persisted in prepareMessage().
   * This method exists for API symmetry and future extensibility.
   */
  async commitMessage(prepared: PreparedMessage): Promise<void> {
    // Session already saved in prepareMessage for forward secrecy.
    // This method can be used for additional bookkeeping if needed.
  }

  /**
   * Decrypt an incoming message.
   * Handles topic routing, signature verification, and session updates.
   * 
   * @param topic - The topic the message arrived on
   * @param payload - Raw message payload (Uint8Array)
   * @param senderSigningKey - Sender's Ed25519 signing public key
   * @param isOwnMessage - Whether this is our own outbound message (echo)
   * @returns DecryptedMessage or null if decryption fails
   */
  async decryptMessage(
    topic: string,
    payload: Uint8Array,
    senderSigningKey: Uint8Array,
    isOwnMessage: boolean = false
  ): Promise<DecryptedMessage | null> {
    if (!this.sessionManager) {
      throw new Error('SessionStore not configured. Call setSessionStore() first.');
    }

    // Skip decryption for own messages (we already have plaintext)
    if (isOwnMessage) {
      return null;
    }

    // Find session by topic
    const result = await this.sessionManager.getByInboundTopic(topic);
    if (!result) {
      return null;
    }

    const { session, topicMatch } = result;

    // Validate payload format
    if (!isRatchetPayload(payload)) {
      return null;
    }

    const parsed = parseRatchetPayload(payload);
    if (!parsed) {
      return null;
    }

    // AUTH-FIRST: Verify signature before any ratchet operations
    const sigValid = verifyMessageSignature(
      parsed.signature,
      parsed.header,
      parsed.ciphertext,
      senderSigningKey
    );

    if (!sigValid) {
      return null;
    }

    // Decrypt
    const decryptResult = ratchetDecrypt(session, parsed.header, parsed.ciphertext);
    if (!decryptResult) {
      return null;
    }

    // Persist updated session
    await this.sessionManager.save(decryptResult.session);

    const plaintextStr = new TextDecoder().decode(decryptResult.plaintext);

    return {
      conversationId: session.conversationId,
      plaintext: plaintextStr,
      isOwnMessage: false,
      session: decryptResult.session,
      topic,
      topicMatch,
    };
  }

  /**
   * Invalidate session cache for a conversation.
   * Call after external session changes (e.g., session reset).
   */
  invalidateSessionCache(conversationId: string): void {
    this.sessionManager?.invalidate(conversationId);
  }

  /**
   * Clear all cached sessions.
   */
  clearSessionCache(): void {
    this.sessionManager?.clearCache();
  }
}
```

### 1.4 SDK Index Exports

**File: `packages/sdk/src/client/index.ts`**

```typescript
export { VerbethClient } from './VerbethClient.js';
export type { 
  SessionStore, 
  PreparedMessage, 
  DecryptedMessage 
} from './types.js';
```

**Update `packages/sdk/src/index.ts`:**

```typescript
// ... existing exports ...
export type { SessionStore, PreparedMessage, DecryptedMessage } from './client/index.js';
```

---

## Milestone 2: Pending Message Manager

### 2.1 Pending Store Interface

**File: `packages/sdk/src/client/types.ts`** (additions)

```typescript

export type PendingStatus = 'preparing' | 'submitted' | 'confirmed' | 'failed';

/**
 * Pending outbound message record.
 */
export interface PendingMessage {
  /** Unique ID */
  id: string;
  /** Conversation ID */
  conversationId: string;
  /** Topic used for sending */
  topic: string;
  /** Hex-encoded payload */
  payloadHex: string;
  /** Original plaintext */
  plaintext: string;
  /** Session state before encryption (serialized JSON) */
  sessionStateBefore: string;
  /** Session state after encryption (serialized JSON) */
  sessionStateAfter: string;
  /** Creation timestamp */
  createdAt: number;
  /** Transaction hash (once submitted) */
  txHash: string | null;
  /** Current status */
  status: PendingStatus;
}

/**
 * Storage interface for pending outbound messages.
 */
export interface PendingStore {
  /**
   * Save a new pending message.
   */
  save(pending: PendingMessage): Promise<void>;

  /**
   * Get pending message by ID.
   */
  get(id: string): Promise<PendingMessage | null>;

  /**
   * Get pending message by transaction hash.
   */
  getByTxHash(txHash: string): Promise<PendingMessage | null>;

  /**
   * Update pending message status.
   */
  updateStatus(id: string, status: PendingStatus, txHash?: string): Promise<void>;

  /**
   * Delete pending message (after confirmation or cancellation).
   */
  delete(id: string): Promise<void>;

  /**
   * Get all pending messages for a conversation.
   */
  getByConversation(conversationId: string): Promise<PendingMessage[]>;
}

/**
 * Result of sendMessage.
 */
export interface SendResult {
  /** Message ID for tracking */
  messageId: string;
  /** Transaction hash */
  txHash: string;
  /** Topic the message was sent on */
  topic: string;
  /** Message number in sending chain */
  messageNumber: number;
}

/**
 * Result of confirmTx.
 */
export interface ConfirmResult {
  /** Conversation ID */
  conversationId: string;
  /** Original plaintext */
  plaintext: string;
  /** Message ID */
  messageId: string;
}
```

### 2.2 Pending Manager (Internal)

**File: `packages/sdk/src/client/PendingManager.ts`**

```typescript
import { hexlify } from 'ethers';
import { PendingStore, PendingMessage, PendingStatus } from './types.js';

/**
 * Internal pending message coordinator.
 */
export class PendingManager {
  constructor(private store: PendingStore) {}

  /**
   * Create and save a pending message record.
   */
  async create(params: Omit<PendingMessage, 'txHash' | 'status'>): Promise<PendingMessage> {
    const pending: PendingMessage = {
      ...params,
      txHash: null,
      status: 'preparing',
    };
    await this.store.save(pending);
    return pending;
  }

  /**
   * Mark as submitted with transaction hash.
   */
  async markSubmitted(id: string, txHash: string): Promise<void> {
    await this.store.updateStatus(id, 'submitted', txHash);
  }

  /**
   * Get pending by transaction hash.
   */
  async getByTxHash(txHash: string): Promise<PendingMessage | null> {
    return this.store.getByTxHash(txHash);
  }

  /**
   * Finalize (confirm) and delete.
   */
  async finalize(id: string): Promise<PendingMessage | null> {
    const pending = await this.store.get(id);
    if (!pending) return null;
    
    await this.store.delete(id);
    return pending;
  }

  /**
   * Mark as failed.
   */
  async markFailed(id: string): Promise<void> {
    await this.store.updateStatus(id, 'failed');
  }

  /**
   * Delete a pending message.
   */
  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }
}
```

### 2.3 VerbethClient Extensions (Milestone 2)

**Add to `packages/sdk/src/client/VerbethClient.ts`:**

```typescript
import { PendingStore, PendingMessage, SendResult, ConfirmResult } from './types.js';
import { PendingManager } from './PendingManager.js';

// Add to VerbethClient class:

export class VerbethClient {
  // ... existing properties ...
  
  private pendingManager?: PendingManager;

  /**
   * Configure pending message storage.
   * Must be called before using sendMessage/confirmTx/revertTx.
   */
  setPendingStore(store: PendingStore): void {
    this.pendingManager = new PendingManager(store);
  }

  /**
   * Send a message with full lifecycle management.
   * 
   * This is the high-level API that handles:
   * 1. Encryption
   * 2. Pending record creation
   * 3. Transaction submission
   * 4. Status tracking
   * 
   * After calling this, wait for on-chain confirmation and call confirmTx().
   */
  async sendMessage(
    conversationId: string,
    plaintext: string
  ): Promise<SendResult> {
    if (!this.sessionManager) {
      throw new Error('SessionStore not configured. Call setSessionStore() first.');
    }
    if (!this.pendingManager) {
      throw new Error('PendingStore not configured. Call setPendingStore() first.');
    }
    if (!this.executorInstance) {
      throw new Error('Executor not configured.');
    }

    // 1. Prepare message (encrypts and persists session)
    const prepared = await this.prepareMessage(conversationId, plaintext);

    // 2. Create pending record
    const pending = await this.pendingManager.create({
      id: prepared.id,
      conversationId,
      topic: prepared.topic,
      payloadHex: hexlify(prepared.payload),
      plaintext,
      sessionStateBefore: JSON.stringify(this.serializeSession(prepared.sessionBefore)),
      sessionStateAfter: JSON.stringify(this.serializeSession(prepared.sessionAfter)),
      createdAt: prepared.createdAt,
    });

    // 3. Submit transaction
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = prepared.messageNumber;

    try {
      const tx = await this.executorInstance.sendMessage(
        prepared.payload,
        prepared.topic,
        timestamp,
        BigInt(nonce)
      );

      // 4. Update pending with txHash
      await this.pendingManager.markSubmitted(prepared.id, tx.hash);

      return {
        messageId: prepared.id,
        txHash: tx.hash,
        topic: prepared.topic,
        messageNumber: nonce,
      };
    } catch (error) {
      // Mark as failed (ratchet slot is burned)
      await this.pendingManager.markFailed(prepared.id);
      throw error;
    }
  }

  /**
   * Confirm a transaction after on-chain confirmation.
   * Call this when you see your MessageSent event on-chain.
   * 
   * @param txHash - Transaction hash to confirm
   * @returns ConfirmResult or null if not found
   */
  async confirmTx(txHash: string): Promise<ConfirmResult | null> {
    if (!this.pendingManager) {
      throw new Error('PendingStore not configured.');
    }

    const pending = await this.pendingManager.getByTxHash(txHash);
    if (!pending || pending.status !== 'submitted') {
      return null;
    }

    // Finalize (delete pending record)
    const finalized = await this.pendingManager.finalize(pending.id);
    if (!finalized) {
      return null;
    }

    return {
      conversationId: finalized.conversationId,
      plaintext: finalized.plaintext,
      messageId: finalized.id,
    };
  }

  /**
   * Handle transaction failure/revert.
   * The ratchet slot is already burned (session was persisted in prepareMessage).
   * This just cleans up the pending record.
   * 
   * @param txHash - Transaction hash that failed
   */
  async revertTx(txHash: string): Promise<void> {
    if (!this.pendingManager) {
      throw new Error('PendingStore not configured.');
    }

    const pending = await this.pendingManager.getByTxHash(txHash);
    if (pending) {
      await this.pendingManager.delete(pending.id);
    }
  }

  /**
   * Serialize session for storage (helper).
   * Apps should use their own serialization if needed.
   */
  private serializeSession(session: RatchetSession): any {
    // Basic serialization - apps can override
    return {
      conversationId: session.conversationId,
      topicEpoch: session.topicEpoch,
      sendingMsgNumber: session.sendingMsgNumber,
      receivingMsgNumber: session.receivingMsgNumber,
      // ... other fields as hex strings
    };
  }
}
```

### 2.4 Updated SDK Exports

**Update `packages/sdk/src/client/index.ts`:**

```typescript
export { VerbethClient } from './VerbethClient.js';
export type { 
  SessionStore, 
  PreparedMessage, 
  DecryptedMessage,
  PendingStore,
  PendingMessage,
  PendingStatus,
  SendResult,
  ConfirmResult,
} from './types.js';
```

---

## App-Side Adapter Implementation

these adapters could also be in the same file.

### SessionStore Adapter

**File: `apps/demo/src/adapters/SessionStoreAdapter.ts`**

```typescript
import type { SessionStore } from '@verbeth/sdk';
import { dbService } from '../services/DbService.js';

/**
 * Adapter connecting VerbethClient SessionStore to app's DbService.
 */
export function createSessionStore(): SessionStore {
  return {
    async get(conversationId: string) {
      return dbService.getRatchetSessionByConversation(conversationId);
    },

    async getByInboundTopic(topic: string) {
      return dbService.getRatchetSessionByAnyInboundTopic(topic);
    },

    async save(session) {
      await dbService.saveRatchetSession(session);
    },
  };
}
```

### PendingStore Adapter

**File: `apps/demo/src/adapters/PendingStoreAdapter.ts`**

```typescript
import type { PendingStore, PendingMessage, PendingStatus } from '@verbeth/sdk';
import { dbService } from '../services/DbService.js';

/**
 * Adapter connecting VerbethClient PendingStore to app's DbService.
 */
export function createPendingStore(): PendingStore {
  return {
    async save(pending: PendingMessage) {
      await dbService.savePendingOutbound(pending);
    },

    async get(id: string) {
      return dbService.getPendingOutbound(id);
    },

    async getByTxHash(txHash: string) {
      return dbService.getPendingOutboundByTxHash(txHash);
    },

    async updateStatus(id: string, status: PendingStatus, txHash?: string) {
      await dbService.updatePendingOutboundStatus(id, status, txHash);
    },

    async delete(id: string) {
      await dbService.deletePendingOutbound(id);
    },

    async getByConversation(conversationId: string) {
      return dbService.getPendingOutboundByConversation(conversationId);
    },
  };
}
```

### Updated App.tsx Initialization

**In `apps/demo/src/App.tsx`:**

```typescript
import { createSessionStore } from './adapters/SessionStoreAdapter.js';
import { createPendingStore } from './adapters/PendingStoreAdapter.js';

// In the useEffect where VerbethClient is created:
useEffect(() => {
  if (executor && identityKeyPair && identityProof && identitySigner && currentAddress) {
    const client = new VerbethClient({
      userAddress: currentAddress,
      identityKeyPair,
      identityProof,
      executor,
      signer: identitySigner,
    });

    // Configure storage adapters
    client.setSessionStore(createSessionStore());
    client.setPendingStore(createPendingStore());

    setVerbethClient(client);
  }
}, [executor, identityKeyPair, identityProof, identitySigner, address]);
```

---

## Simplified useMessageQueue (After Milestones 1 & 2)

**File: `apps/demo/src/hooks/useMessageQueue.ts`** (refactored)

```typescript
import { useCallback, useRef, useEffect } from "react";
import { VerbethClient } from "@verbeth/sdk";
import { Contact, Message, generateTempMessageId } from "../types.js";

interface UseMessageQueueProps {
  verbethClient: VerbethClient | null;
  addLog: (message: string) => void;
  addMessage: (message: Message) => Promise<void>;
  updateMessageStatus: (id: string, status: Message["status"], error?: string) => Promise<void>;
  removeMessage: (id: string) => Promise<void>;
  updateContact: (contact: Contact) => Promise<void>;
}

export interface QueuedMessage {
  id: string;
  conversationId: string;
  contact: Contact;
  plaintext: string;
  status: 'queued' | 'sending' | 'pending' | 'confirmed' | 'failed';
  error?: string;
  txHash?: string;
  createdAt: number;
}

interface ConversationQueue {
  messages: QueuedMessage[];
  isProcessing: boolean;
}

export const useMessageQueue = ({
  verbethClient,
  addLog,
  addMessage,
  updateMessageStatus,
  removeMessage,
  updateContact,
}: UseMessageQueueProps) => {
  const queuesRef = useRef<Map<string, ConversationQueue>>(new Map());
  const failedMessagesRef = useRef<Map<string, QueuedMessage>>(new Map());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const processQueue = useCallback(async (conversationId: string) => {
    if (!verbethClient || !mountedRef.current) return;

    const queue = queuesRef.current.get(conversationId);
    if (!queue || queue.isProcessing || queue.messages.length === 0) return;

    queue.isProcessing = true;

    while (queue.messages.length > 0 && mountedRef.current) {
      const message = queue.messages[0];
      
      if (message.status === 'confirmed' || message.status === 'pending') {
        queue.messages.shift();
        continue;
      }

      if (message.status === 'failed') {
        queue.messages.shift();
        continue;
      }

      try {
        message.status = 'sending';

        // =====================================================================
        // SDK handles everything: encryption, session persistence, pending tracking
        // =====================================================================
        const result = await verbethClient.sendMessage(
          conversationId,
          message.plaintext
        );

        message.id = result.messageId;
        message.txHash = result.txHash;
        message.status = 'pending';

        addLog(`📤 Message sent: "${message.plaintext.slice(0, 30)}..." (tx: ${result.txHash.slice(0, 10)}..., n=${result.messageNumber})`);

        // Update contact with current topic
        const updatedContact: Contact = {
          ...message.contact,
          lastMessage: message.plaintext,
          lastTimestamp: Date.now(),
        };
        await updateContact(updatedContact);

        queue.messages.shift();

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        
        message.status = 'failed';
        message.error = errorMessage;

        await updateMessageStatus(message.id, 'failed', errorMessage);
        addLog(`✗ Failed to send: "${message.plaintext.slice(0, 20)}..." - ${errorMessage}`);

        failedMessagesRef.current.set(message.id, { ...message });
        queue.messages.shift();
      }
    }

    queue.isProcessing = false;
  }, [verbethClient, addLog, updateContact, updateMessageStatus]);

  const queueMessage = useCallback(async (
    contact: Contact,
    messageText: string
  ): Promise<string | null> => {
    if (!verbethClient || !contact.conversationId) {
      addLog('✗ Cannot queue message: missing client or conversation');
      return null;
    }

    const messageId = generateTempMessageId();
    const conversationId = contact.conversationId;

    const queuedMessage: QueuedMessage = {
      id: messageId,
      conversationId,
      contact,
      plaintext: messageText,
      status: 'queued',
      createdAt: Date.now(),
    };

    let queue = queuesRef.current.get(conversationId);
    if (!queue) {
      queue = { messages: [], isProcessing: false };
      queuesRef.current.set(conversationId, queue);
    }
    queue.messages.push(queuedMessage);

    // Optimistic UI
    const optimisticMessage: Message = {
      id: messageId,
      topic: contact.topicOutbound || '',
      sender: verbethClient.userAddress,
      recipient: contact.address,
      ciphertext: '',
      timestamp: Date.now(),
      blockTimestamp: Date.now(),
      blockNumber: 0,
      direction: 'outgoing',
      decrypted: messageText,
      read: true,
      nonce: 0,
      dedupKey: `pending-${messageId}`,
      type: 'text',
      ownerAddress: verbethClient.userAddress,
      status: 'pending',
    };

    await addMessage(optimisticMessage);
    addLog(`📝 Message queued: "${messageText.slice(0, 30)}..."`);

    setTimeout(() => processQueue(conversationId), 0);
    return messageId;
  }, [verbethClient, addLog, addMessage, processQueue]);

  // ... retryMessage, cancelMessage, getQueueStatus remain largely the same ...

  return {
    queueMessage,
    retryMessage: useCallback(async (id: string) => { /* ... */ }, []),
    cancelMessage: useCallback(async (id: string) => { /* ... */ }, []),
    getQueueStatus: useCallback((convId: string) => { /* ... */ }, []),
    invalidateSessionCache: useCallback((convId: string) => {
      verbethClient?.invalidateSessionCache(convId);
    }, [verbethClient]),
    clearAllQueues: useCallback(() => {
      queuesRef.current.clear();
      failedMessagesRef.current.clear();
      verbethClient?.clearSessionCache();
    }, [verbethClient]),
  };
};
```

---

## Simplified EventProcessorService (After Milestone 1)

**In `apps/demo/src/services/EventProcessorService.ts`:**

The `processMessageEvent` function becomes simpler:

```typescript
export async function processMessageEvent(
  event: ProcessedEvent,
  address: string,
  emitterAddress: string | undefined,
  verbethClient: VerbethClient,  // Now we pass the client
  onLog: (msg: string) => void
): Promise<MessageResult | null> {
  try {
    const log = event.rawLog;
    const abiCoder = new AbiCoder();
    const [ciphertextBytes, timestamp, topic, nonce] = abiCoder.decode(
      ['bytes', 'uint256', 'bytes32', 'uint256'],
      log.data
    );

    const sender = '0x' + log.topics[1].slice(-40);
    const ciphertextRaw = hexToUint8Array(ciphertextBytes);

    const isOurMessage =
      sender.toLowerCase() === address.toLowerCase() ||
      (emitterAddress && sender.toLowerCase() === emitterAddress.toLowerCase());

    // =========================================================================
    // OUTGOING CONFIRMATION - Use SDK's confirmTx
    // =========================================================================
    if (isOurMessage) {
      const confirmed = await verbethClient.confirmTx(log.transactionHash);
      if (confirmed) {
        onLog(`✅ Message confirmed: "${confirmed.plaintext.slice(0, 30)}..."`);
        return {
          messageUpdate: [confirmed.messageId, { status: 'confirmed' }],
        };
      }
      return null;
    }

    // =========================================================================
    // INCOMING MESSAGE - Use SDK's decryptMessage
    // =========================================================================
    
    // Get contact for signing key
    const contact = await dbService.getContactByTopic(topic, address);
    if (!contact?.signingPubKey) {
      onLog(`❓ No contact found for topic ${topic.slice(0, 10)}...`);
      return null;
    }

    const decrypted = await verbethClient.decryptMessage(
      topic,
      ciphertextRaw,
      contact.signingPubKey,
      isOurMessage
    );

    if (!decrypted) {
      onLog(`✗ Failed to decrypt message from ${sender.slice(0, 8)}...`);
      return null;
    }

    const message: Message = {
      id: generateMessageId(log.transactionHash, log),
      topic,
      sender: contact.address,
      recipient: address,
      ciphertext: hexlify(ciphertextRaw),
      timestamp: Number(timestamp) * 1000,
      blockTimestamp: Date.now(),
      blockNumber: log.blockNumber,
      direction: 'incoming',
      decrypted: decrypted.plaintext,
      read: false,
      nonce: Number(nonce),
      dedupKey: `msg-${log.transactionHash}-${log.logIndex}`,
      type: 'text',
      ownerAddress: address,
      status: 'confirmed',
    };

    // Update contact topics if they changed
    const updatedContact: Contact = {
      ...contact,
      topicInbound: decrypted.session.currentTopicInbound,
      topicOutbound: decrypted.session.currentTopicOutbound,
      lastMessage: decrypted.plaintext,
      lastTimestamp: Date.now(),
    };

    await dbService.saveMessage(message);
    await dbService.saveContact(updatedContact);

    onLog(`📩 Message from ${contact.address.slice(0, 8)}...: "${decrypted.plaintext}"`);

    return { newMessage: message, contactUpdate: updatedContact };
  } catch (error) {
    onLog(`✗ Failed to process message: ${error}`);
    return null;
  }
}
```

---

## Migration Guide

All changes are additive. Existing code continues to work. However, we must now prune old code no longer needed (like duplexTopics).

### Recommended Migration Path

1. **Add adapters** to your app (SessionStoreAdapter, PendingStoreAdapter)
2. **Configure VerbethClient** with `setSessionStore()` and `setPendingStore()` after creation
3. **Gradually replace** direct session/pending operations with SDK methods:
   - Replace manual `ratchetEncrypt` + session save → `client.prepareMessage()`
   - Replace pending record creation → already handled by `client.sendMessage()`
   - Replace manual decryption flow → `client.decryptMessage()`
   - Replace confirmation matching → `client.confirmTx()`

4. **Remove** duplicated logic:
   - Session cache in hooks (SDK manages internally)
   - Topic promotion logic (SDK handles in `getByInboundTopic`)


---

## Milestone 3: Event Processor Helpers

### Goal
Simplify event processing loops.

```ts
interface ProcessedIncomingMessage {
  conversationId: string;
  plaintext: string;
  sender: string;
  topic: string;
  isOwnMessage: boolean;
}
```

```ts
class VerbethClient {
  async processMessageEvent(event: {
    topic: string;
    payload: Uint8Array;
    txHash: string;
    sender?: string;
  }): Promise<ProcessedIncomingMessage | null>;

  async processMessageEvents(events: Array<any>): Promise<ProcessedIncomingMessage[]>;
}
```

---

## App-Side Example

```ts
const sessionStore: SessionStore = {
  get: (id) => dbService.getRatchetSessionByConversation(id),
  getByInboundTopic: (topic) =>
    dbService.getRatchetSessionByAnyInboundTopic(topic),
  save: (session) => dbService.saveRatchetSession(session),
};

verbethClient.setSessionStore(sessionStore);
```
