// packages/sdk/src/ratchet/types.ts

/**
 * Double Ratchet types and constants.
 */

/**
 * Sanity cap per ratchet step, protects against malicious peers or corrupted state.
 */
export const MAX_SKIP_PER_MESSAGE = 100_000;

/**
 * When exceeded, oldest keys are pruned.
 */
export const MAX_STORED_SKIPPED_KEYS = 1000;

/**
 * Skipped keys TTL (24 hours is sufficient for reorg tolerance).
 * (this is not message expiry as sequential messages don't use skipped keys)
 */
export const MAX_SKIPPED_KEYS_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Yield to UI every N derivations during large backlog processing.
 */
export const SYNC_BATCH_SIZE = 10_000;

/**
 * Binary payload version byte.
 */
export const RATCHET_VERSION_V1 = 0x01;

/**
 * Topic transition window (5 minutes).
 */
export const TOPIC_TRANSITION_WINDOW_MS = 5 * 60 * 1000;

/**
 * Ratchet session state.
 * 
 * This is stateful - must be persisted after every encrypt/decrypt.
 * Session is identified by conversationId (derived from topics), enabling
 * correct handling of Safe addresses vs EOAs.
 */
export interface RatchetSession {
  // === Conversation Identity ===
  /** Primary key: keccak256(sort([topicOut, topicIn])) */
  conversationId: string;
  /** Original handshake-derived outbound topic (immutable reference) */
  topicOutbound: `0x${string}`;
  /** Original handshake-derived inbound topic (immutable reference) */
  topicInbound: `0x${string}`;
  /** My EOA address (for convenience/lookup) */
  myAddress: string;
  /** Their EOA address (for convenience/lookup) */
  contactAddress: string;

  // === Root Ratchet ===
  /** Current root key (32 bytes) */
  rootKey: Uint8Array;

  // === DH Ratchet Keys ===
  /** My current DH secret key (32 bytes) */
  dhMySecretKey: Uint8Array;
  /** My current DH public key (32 bytes) */
  dhMyPublicKey: Uint8Array;
  /** Their last received DH public key (32 bytes) */
  dhTheirPublicKey: Uint8Array;

  // === Sending Chain ===
  /** Current sending chain key (null until first DH ratchet as sender) */
  sendingChainKey: Uint8Array | null;
  /** Next sending message number (Ns) */
  sendingMsgNumber: number;

  // === Receiving Chain ===
  /** Current receiving chain key (null until first message received) */
  receivingChainKey: Uint8Array | null;
  /** Next expected receiving message number (Nr) */
  receivingMsgNumber: number;

  // === Skip Handling ===
  /** Message count in previous sending chain (PN header field) */
  previousChainLength: number;
  /** Stored keys for out-of-order messages */
  skippedKeys: SkippedKey[];

  // === Topic Ratcheting ===
  currentTopicOutbound: `0x${string}`;
  currentTopicInbound: `0x${string}`;
  nextTopicOutbound?: `0x${string}`;
  nextTopicInbound?: `0x${string}`;
  previousTopicInbound?: `0x${string}`;
  previousTopicExpiry?: number;
  topicEpoch: number;

  // === Metadata ===
  /** Session creation timestamp */
  createdAt: number;
  /** Last state update timestamp */
  updatedAt: number;

  // === Recovery ===
  /** Increments on session reset (internal bookkeeping only) */
  epoch: number;
}

/**
 * Stored key for out-of-order message decryption.
 */
export interface SkippedKey {
  /** DH epoch identifier (hex of their DH pubkey) */
  dhPubKeyHex: string;
  /** Message number in that epoch */
  msgNumber: number;
  /** Derived message key (32 bytes) */
  messageKey: Uint8Array;
  /** Creation timestamp for TTL pruning */
  createdAt: number;
}

/**
 * Message header (40 bytes when encoded).
 */
export interface MessageHeader {
  /** Sender's current DH ratchet public key (32 bytes) */
  dh: Uint8Array;
  /** Previous chain length - messages in sender's previous sending chain */
  pn: number;
  /** Message number in current sending chain */
  n: number;
}

/**
 * Result of ratchetEncrypt - includes new session state for two-phase commit.
 */
export interface EncryptResult {
  session: RatchetSession;
  header: MessageHeader;
  ciphertext: Uint8Array;
  signature: Uint8Array;
  /** Current outbound topic to use for this message */
  topic: `0x${string}`;
}

/**
 * Result of ratchetDecrypt.
 */
export interface DecryptResult {
  session: RatchetSession;
  plaintext: Uint8Array;
}

/**
 * Parsed binary ratchet payload.
 */
export interface ParsedRatchetPayload {
  version: number;
  signature: Uint8Array;
  header: MessageHeader;
  ciphertext: Uint8Array;
}

/**
 * Parameters for initializing session as responder.
 */
export interface InitResponderParams {
  myAddress: string;
  contactAddress: string;
  /** Ephemeral secret used in HandshakeResponse (becomes dhMySecretKey) */
  myResponderEphemeralSecret: Uint8Array;
  myResponderEphemeralPublic: Uint8Array;
  /** Initiator's ephemeral from Handshake event */
  theirHandshakeEphemeralPubKey: Uint8Array;
  topicOutbound: `0x${string}`;
  topicInbound: `0x${string}`;
}

/**
 * Parameters for initializing session as initiator.
 */
export interface InitInitiatorParams {
  myAddress: string;
  contactAddress: string;
  /** Handshake ephemeral secret (must persist until response arrives) */
  myHandshakeEphemeralSecret: Uint8Array;

  theirResponderEphemeralPubKey: Uint8Array;
  topicOutbound: `0x${string}`;
  topicInbound: `0x${string}`;
}