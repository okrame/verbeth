import type { IdentityKeyPair, IdentityProof, RatchetSession as SDKRatchetSession, } from '@verbeth/sdk';
import { getVerbethAddress, getCreationBlock, SCAN_DEFAULTS } from '@verbeth/sdk';
import { keccak256, toUtf8Bytes, hexlify, getBytes } from 'ethers';

/* ------------------------------- CONSTANTS -------------------------------- */
// Re-export from SDK for backward compatibility
export const VERBETH_SINGLETON_ADDR = getVerbethAddress();
export const CONTRACT_CREATION_BLOCK = getCreationBlock();
export const { INITIAL_SCAN_BLOCKS, MAX_RETRIES, MAX_RANGE_PROVIDER, CHUNK_SIZE, REAL_TIME_BUFFER } = SCAN_DEFAULTS;

export const SAFE_MODULE_ADDRESS = import.meta.env.VITE_SAFE_SESSION_MODULE as `0x${string}`

/* --------------------------- EVENT SIGNATURES ---------------------------- */
export const EVENT_SIGNATURES = {
  MessageSent: keccak256(
    toUtf8Bytes('MessageSent(address,bytes,uint256,bytes32,uint256)'),
  ),
  Handshake: keccak256(
    toUtf8Bytes('Handshake(bytes32,address,bytes,bytes,bytes)'),
  ),
  HandshakeResponse: keccak256(
    toUtf8Bytes('HandshakeResponse(bytes32,address,bytes32,bytes)'),
  ),
};

/* ------------------------------- ENTITIES -------------------------------- */
export interface Contact {
  address: string; // Contact's address (EOA or Safe) */
  emitterAddress?: string;
  ownerAddress: string;
  name?: string;
  identityPubKey?: Uint8Array;
  signingPubKey?: Uint8Array;
  topicOutbound?: string;
  topicInbound?: string;
  status: "none" | "handshake_sent" | "established";
  lastMessage?: string;
  lastTimestamp?: number;
  unreadCount?: number;
  note?: string;

  conversationId?: string;
  previousConversationId?: string;
  handshakeEphemeralSecret?: string;
  handshakeKemSecret?: string; // ML-KEM secret for PQ-hybrid (hex)
  sessionResetAt?: number;
}


export interface Message {
  id: string; // Unique ID (txHash-logIndex or dedupKey)
  ownerAddress: string; // which account own this contact
  topic: string; // Topic/conversation hash
  sender: string; // Sender address
  recipient?: string; // Recipient address (if known)
  ciphertext: string; // Encrypted message (JSON/base64)
  timestamp: number; // Sender declared timestamp (ms)
  blockTimestamp: number; // Block timestamp (ms)
  blockNumber: number; // Block number for ordering
  direction: 'incoming' | 'outgoing';
  decrypted?: string; // Decrypted content (if available)
  read: boolean; // Read status
  nonce: number; // Sender nonce for replay protection
  dedupKey: string; 
  type: 'text' | 'system';
  status: 'pending' | 'confirmed' | 'failed';
  verified?: boolean;
  isLost?: boolean;
}

export interface PendingHandshake {
  id: string;
  ownerAddress: string;
  emitterAddress?: string;
  sender: string;
  identityPubKey: Uint8Array;
  signingPubKey: Uint8Array;
  ephemeralPubKey: Uint8Array;      // X25519 part only (32 bytes) - for backward compat
  ephemeralPubKeyFull: Uint8Array;  // Full key (may be 1216 bytes with KEM)
  message: string;
  timestamp: number;
  blockNumber: number;
  verified: boolean;
  isExistingContact?: boolean;
  previousConversationId?: string;
}

export type ExecutionMode = 'classic' | 'fast' | 'custom';

export interface StoredIdentity {
  address: string;
  keyPair: IdentityKeyPair;
  derivedAt: number;
  proof?: IdentityProof;
  sessionPrivateKey?: string; // Derived deterministically from the same seed signature as identity keys.
  sessionAddress?: string;
  executionMode?: ExecutionMode;
  emitterAddress?: string; // EOA for classic, Safe for fast/custom
}

// Extends SDK RatchetSession with serialization-friendly format.
export interface StoredRatchetSession {
  conversationId: string;
  topicOutbound: string;
  topicInbound: string;
  myAddress: string;
  contactAddress: string;
  rootKey: string;
  dhMySecretKey: string;
  dhMyPublicKey: string;
  dhTheirPublicKey: string;
  sendingChainKey: string | null;
  sendingMsgNumber: number;
  receivingChainKey: string | null;
  receivingMsgNumber: number;
  previousChainLength: number;
  skippedKeys: StoredSkippedKey[];
  createdAt: number;
  updatedAt: number;
  epoch: number;
  
  // === Topic Ratcheting ===
  currentTopicOutbound: string;
  currentTopicInbound: string;
  nextTopicOutbound?: string;
  nextTopicInbound?: string;
  previousTopicInbound?: string;
  previousTopicExpiry?: number;
  topicEpoch: number;
}

export interface StoredSkippedKey {
  dhPubKeyHex: string;
  msgNumber: number;
  messageKey: string;
  createdAt: number;
}

export interface PendingOutbound {
  id: string;
  conversationId: string;
  topic: string;
  payloadHex: string;
  plaintext: string;
  sessionStateBefore: string;
  sessionStateAfter: string;
  createdAt: number;
  txHash: string | null;
  status: 'preparing' | 'submitted' | 'confirmed' | 'failed';
}


export interface AppSettings {
  name: string;
  value: any;
}

/* ----------------------------- DB SCHEMA MAP ----------------------------- */
export interface DbSchema {
  identity: StoredIdentity;
  contacts: Contact;
  messages: Message;
  pendingHandshakes: PendingHandshake;
  settings: AppSettings;
}

/* ----------------------------- HELPER TYPES ------------------------------ */
export type EventType = 'handshake' | 'handshake_response' | 'message';
export type MessageDirection = 'incoming' | 'outgoing';
export type ContactStatus = 'none' | 'handshake_sent' | 'established';
export type MessageType = 'text' | 'system';

export interface ScanProgress {
  current: number;
  total: number;
}

export interface ScanChunk {
  fromBlock: number;
  toBlock: number;
  loaded: boolean;
  events: any[];
}

export interface ProcessedEvent {
  logKey: string;
  eventType: EventType;
  rawLog: any;
  blockNumber: number;
  timestamp: number;
  matchedContactAddress?: string;
}

export interface MessageListenerResult {
  isInitialLoading: boolean;
  isLoadingMore: boolean;
  canLoadMore: boolean;
  syncProgress: ScanProgress | null;
  loadMoreHistory: () => Promise<void>;
  lastKnownBlock: number | null;
  oldestScannedBlock: number | null;
}

export interface MessageProcessorResult {
  messages: Message[];
  pendingHandshakes: PendingHandshake[];
  contacts: Contact[];
  addMessage: (message: Message) => void;
  updateMessageStatus: (id: string, status: Message["status"], error?: string) => Promise<void>;
  removeMessage: (id: string) => Promise<void>;
  removePendingHandshake: (id: string) => void;
  updateContact: (contact: Contact) => void;
  processEvents: (events: ProcessedEvent[]) => Promise<void>;
  markMessagesLost: (contactAddress: string, afterTimestamp: number) => Promise<number>;
}


export const generateTempMessageId = () => `temp-${Date.now()}-${Math.random()}`;

// =============================================================================
// SERIALIZATION HELPERS
// =============================================================================

/**
 * Convert SDK RatchetSession to storable format.
 */
export function serializeRatchetSession(session: SDKRatchetSession): StoredRatchetSession {
  return {
    conversationId: session.conversationId,
    topicOutbound: session.topicOutbound.toLowerCase() as `0x${string}`,
    topicInbound: session.topicInbound.toLowerCase() as `0x${string}`,
    myAddress: session.myAddress.toLowerCase(),
    contactAddress: session.contactAddress.toLowerCase(),

    rootKey: hexlify(session.rootKey),
    dhMySecretKey: hexlify(session.dhMySecretKey),
    dhMyPublicKey: hexlify(session.dhMyPublicKey),
    dhTheirPublicKey: hexlify(session.dhTheirPublicKey),

    sendingChainKey: session.sendingChainKey ? hexlify(session.sendingChainKey) : null,
    sendingMsgNumber: session.sendingMsgNumber,
    receivingChainKey: session.receivingChainKey ? hexlify(session.receivingChainKey) : null,
    receivingMsgNumber: session.receivingMsgNumber,

    previousChainLength: session.previousChainLength,
    skippedKeys: session.skippedKeys.map((sk: any) => ({
      dhPubKeyHex: sk.dhPubKeyHex,
      msgNumber: sk.msgNumber,
      messageKey: hexlify(sk.messageKey),
      createdAt: sk.createdAt,
    })),

    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    epoch: session.epoch,
    
    // Topic Ratcheting
    currentTopicOutbound: session.currentTopicOutbound.toLowerCase(),
    currentTopicInbound: session.currentTopicInbound.toLowerCase(),
    nextTopicOutbound: session.nextTopicOutbound?.toLowerCase(),
    nextTopicInbound: session.nextTopicInbound?.toLowerCase(),
    previousTopicInbound: session.previousTopicInbound?.toLowerCase(),
    previousTopicExpiry: session.previousTopicExpiry,
    topicEpoch: session.topicEpoch,
  };
}

/**
 * Convert stored format back to SDK RatchetSession.
 */
export function deserializeRatchetSession(stored: StoredRatchetSession): SDKRatchetSession {
  return {
    conversationId: stored.conversationId,
    topicOutbound: stored.topicOutbound as `0x${string}`,
    topicInbound: stored.topicInbound as `0x${string}`,
    myAddress: stored.myAddress,
    contactAddress: stored.contactAddress,

    rootKey: getBytes(stored.rootKey),
    dhMySecretKey: getBytes(stored.dhMySecretKey),
    dhMyPublicKey: getBytes(stored.dhMyPublicKey),
    dhTheirPublicKey: getBytes(stored.dhTheirPublicKey),

    sendingChainKey: stored.sendingChainKey ? getBytes(stored.sendingChainKey) : null,
    sendingMsgNumber: stored.sendingMsgNumber,
    receivingChainKey: stored.receivingChainKey ? getBytes(stored.receivingChainKey) : null,
    receivingMsgNumber: stored.receivingMsgNumber,

    previousChainLength: stored.previousChainLength,
    skippedKeys: stored.skippedKeys.map((sk) => ({
      dhPubKeyHex: sk.dhPubKeyHex,
      msgNumber: sk.msgNumber,
      messageKey: getBytes(sk.messageKey),
      createdAt: sk.createdAt,
    })),

    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    epoch: stored.epoch,
    
    // Topic Ratcheting
    currentTopicOutbound: stored.currentTopicOutbound as `0x${string}`,
    currentTopicInbound: stored.currentTopicInbound as `0x${string}`,
    nextTopicOutbound: stored.nextTopicOutbound as `0x${string}` | undefined,
    nextTopicInbound: stored.nextTopicInbound as `0x${string}` | undefined,
    previousTopicInbound: stored.previousTopicInbound as `0x${string}` | undefined,
    previousTopicExpiry: stored.previousTopicExpiry,
    topicEpoch: stored.topicEpoch,
  };
}