import type { IdentityKeyPair, IdentityProof } from '@verbeth/sdk';
import { keccak256, toUtf8Bytes } from 'ethers';

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
  address: string;
  ownerAddress: string; 
  identityPubKey?: Uint8Array; 
  signingPubKey?: Uint8Array; 
  ephemeralKey?: Uint8Array; 
  topicOutbound?: string; 
  topicInbound?: string;
  status: 'none' | 'handshake_sent' | 'established';
  lastMessage?: string;
  lastTimestamp?: number;
  note?: string;
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
  sender: string;
  identityPubKey: Uint8Array;
  signingPubKey: Uint8Array;
  ephemeralPubKey: Uint8Array;
  message: string;
  timestamp: number;
  blockNumber: number;
  verified: boolean;
}

export interface StoredIdentity {
  address: string; // primary key
  keyPair: IdentityKeyPair; // X25519 + Ed25519 keys
  derivedAt: number; 
  proof: IdentityProof; 
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