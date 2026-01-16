// packages/sdk/src/client/types.ts

/**
 * Client types for VerbethClient.
 * 
 * Includes storage interfaces that apps implement to connect
 * VerbethClient to their persistence layer.
 */

import type { Signer } from 'ethers';
import type { IExecutor } from '../executor.js';
import type { IdentityKeyPair, IdentityProof, DuplexTopics } from '../types.js';
import type { RatchetSession } from '../ratchet/types.js';
import type nacl from 'tweetnacl';

/**
 * Configuration for creating a VerbethClient instance.
 */
export interface VerbethClientConfig {
  executor: IExecutor;
  identityKeyPair: IdentityKeyPair;
  identityProof: IdentityProof;
  signer: Signer;
  address: string;
}

export interface HandshakeResult {
  tx: any;
  ephemeralKeyPair: nacl.BoxKeyPair; // must persist secretKey for ratchet session init
}

export interface HandshakeResponseResult {
  tx: any;
  duplexTopics: DuplexTopics;
  tag: `0x${string}`;
  salt: Uint8Array;
  responderEphemeralSecret: Uint8Array; //  must persist as dhMySecretKey in ratchet
  responderEphemeralPublic: Uint8Array;
}

/**
 * Storage interface for ratchet sessions.
 * Implement this to connect VerbethClient to your storage layer.
 */
export interface SessionStore {
  get(conversationId: string): Promise<RatchetSession | null>;

  /**
   * Find session by any active inbound topic.
   * Must check: currentTopicInbound, nextTopicInbound, previousTopicInbound (if not expired).
   */
  getByInboundTopic(topic: string): Promise<RatchetSession | null>;
  save(session: RatchetSession): Promise<void>;
}

/**
 * Result of prepareMessage - contains everything needed to send and commit.
 * 
 * Two-phase commit pattern:
 * 1. prepareMessage() - encrypts and returns PreparedMessage
 * 2. Send transaction using prepared.payload and prepared.topic
 * 3. Session state is already committed for forward secrecy
 */
export interface PreparedMessage {
  id: string;
  conversationId: string;
  topic: `0x${string}`;
  payload: Uint8Array;
  plaintext: string;
  sessionBefore: RatchetSession;
  sessionAfter: RatchetSession;
  messageNumber: number;
  createdAt: number;
}

/**
 * Result of decryptMessage.
 */
export interface DecryptedMessage {
  conversationId: string;
  plaintext: string;
  isOwnMessage: boolean;
  session: RatchetSession;
  topic: string;
  topicMatch: 'current' | 'next' | 'previous';
}


export type PendingStatus = 'preparing' | 'submitted' | 'confirmed' | 'failed';

/**
 * Pending outbound message record.
 * Used for matching on-chain confirmations to sent messages.
 */
export interface PendingMessage {
  id: string;
  conversationId: string;
  topic: string;
  payloadHex: string;
  plaintext: string;
  sessionStateBefore: string;
  sessionStateAfter: string;
  createdAt: number;
  txHash: string | null;
  status: PendingStatus;
}

/**
 * Storage interface for pending outbound messages.
 * Implement this to enable sendMessage/confirmTx/revertTx.
 */
export interface PendingStore {
  save(pending: PendingMessage): Promise<void>;
  get(id: string): Promise<PendingMessage | null>;
  getByTxHash(txHash: string): Promise<PendingMessage | null>;
  updateStatus(id: string, status: PendingStatus, txHash?: string): Promise<void>;
  delete(id: string): Promise<void>;
  getByConversation(conversationId: string): Promise<PendingMessage[]>;
}

/**
 * Result of sendMessage.
 */
export interface SendResult {
  messageId: string;
  txHash: string;
  topic: `0x${string}`;
  messageNumber: number;
}


export interface ConfirmResult {
  conversationId: string;
  plaintext: string;
  messageId: string;
}

export interface SerializedSessionInfo {
  conversationId: string;
  topicEpoch: number;
  sendingMsgNumber: number;
  receivingMsgNumber: number;
  currentTopicOutbound: string;
  currentTopicInbound: string;
}