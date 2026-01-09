import type { IdentityKeyPair, IdentityProof, RatchetSession as SDKRatchetSession, SessionStatus, SkippedKey  } from '@verbeth/sdk';
import { keccak256, toUtf8Bytes, hexlify, getBytes } from 'ethers';
export type { SessionStatus } from '@verbeth/sdk';

/* ------------------------------- CONSTANTS -------------------------------- */
export const LOGCHAIN_SINGLETON_ADDR =
  '0x41a3eaC0d858028E9228d1E2092e6178fc81c4f0';
export const CONTRACT_CREATION_BLOCK = 36_053_269;
export const INITIAL_SCAN_BLOCKS = 1_000;
export const MAX_RETRIES = 3;
export const MAX_RANGE_PROVIDER = 2_000;
export const CHUNK_SIZE = 2_000;
export const REAL_TIME_BUFFER = 3;

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
  /** Contact's address (EOA or Safe) */
  address: string;
  /** Contact's emitter address (Safe in fast mode, same as address in classic mode) */
  emitterAddress?: string;
  /** Owner's address (the user viewing this contact) */
  ownerAddress: string;
  /** Contact's display name */
  name?: string;
  /** Contact's X25519 public key for encryption */
  identityPubKey?: Uint8Array;
  /** Contact's Ed25519 public key for signature verification */
  signingPubKey?: Uint8Array;
  /** Topic for outbound messages (owner → contact) */
  topicOutbound?: string;
  /** Topic for inbound messages (contact → owner) */
  topicInbound?: string;
  /** Contact status */
  status: "none" | "handshake_sent" | "established";
  /** Last message preview */
  lastMessage?: string;
  /** Last message timestamp */
  lastTimestamp?: number;
  /** Unread message count */
  unreadCount?: number;
  note?: string;

  /** Conversation ID for ratchet session lookup */
  conversationId?: string;
  /** Previous conversation ID (after session reset) */
  previousConversationId?: string;
  /** Initiator's ephemeral secret (stored until handshake response received) */
  handshakeEphemeralSecret?: string; // hex
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
}

export interface PendingHandshake {
  id: string;
  ownerAddress: string; 
  emitterAddress?: string;
  sender: string;
  identityPubKey: Uint8Array;
  signingPubKey: Uint8Array;
  ephemeralPubKey: Uint8Array;
  message: string;
  timestamp: number;
  blockNumber: number;
  verified: boolean;
}

export type ExecutionMode = 'classic' | 'fast' | 'custom';

export interface StoredIdentity {
  /** EOA address */
  address: string;
  /** VerbEth identity key pair (X25519 + Ed25519) */
  keyPair: IdentityKeyPair;
  /** Timestamp when identity was derived */
  derivedAt: number;
  /** Binding proof (ties keys to Safe address) */
  proof?: IdentityProof;
  /**
   * Hex-encoded secp256k1 private key for session signer.
   * Derived deterministically from the same seed signature as identity keys.
   */
  sessionPrivateKey?: string;
  /**
   * Ethereum address of the session signer.
   */
  sessionAddress?: string;
  executionMode?: ExecutionMode;
  emitterAddress?: string; // EOA for classic, Safe for fast/custom
}

// **
//  * Stored ratchet session in IndexedDB.
//  * Extends SDK RatchetSession with serialization-friendly format.
//  */
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
  status: SessionStatus;
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
  removePendingHandshake: (id: string) => void;
  updateContact: (contact: Contact) => void;
  processEvents: (events: ProcessedEvent[]) => Promise<void>;
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
    myAddress: session.myAddress,
    contactAddress: session.contactAddress,

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
    status: session.status,
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
    status: stored.status,
  };
}