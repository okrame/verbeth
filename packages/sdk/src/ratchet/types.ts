// packages/sdk/src/ratchet/types.ts

/**
 * Double Ratchet types and constants for Verbeth E2EE messaging.
 * 
 * Key design decisions:
 * - Sessions keyed by conversationId (derived from topics), NOT addresses
 * - Initial secret from ephemeral-only DH (no identity keys) for true forward secrecy
 * - Ed25519 signatures mandatory on all messages (DoS protection)
 */

// =============================================================================
// Constants
// =============================================================================

/**
 * Sanity cap per ratchet step - protects against malicious peers or corrupted state.
 * Auth-before-ratchet prevents external attackers; this caps internal state issues.
 */
export const MAX_SKIP_PER_MESSAGE = 100_000;

/**
 * Maximum stored skipped keys (memory/storage bound).
 * When exceeded, oldest keys are pruned.
 */
export const MAX_STORED_SKIPPED_KEYS = 1000;

/**
 * Skipped keys TTL - 24 hours is sufficient for reorg tolerance.
 * This is NOT message expiry; sequential messages don't use skipped keys.
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

// =============================================================================
// Core Types
// =============================================================================

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
  /** My sending topic (bytes32 hex) */
  topicOutbound: `0x${string}`;
  /** My receiving topic (bytes32 hex) */
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

// =============================================================================
// Result Types
// =============================================================================

/**
 * Result of ratchetEncrypt - includes new session state for two-phase commit.
 */
export interface EncryptResult {
  /** Updated session state (caller must persist after tx confirms) */
  session: RatchetSession;
  /** Message header */
  header: MessageHeader;
  /** Encrypted payload (nonce + ciphertext) */
  ciphertext: Uint8Array;
  /** Ed25519 signature over (header || ciphertext) */
  signature: Uint8Array;
}

/**
 * Result of ratchetDecrypt.
 */
export interface DecryptResult {
  /** Updated session state (caller must persist) */
  session: RatchetSession;
  /** Decrypted plaintext */
  plaintext: Uint8Array;
}

/**
 * Parsed binary ratchet payload.
 */
export interface ParsedRatchetPayload {
  /** Protocol version */
  version: number;
  /** Ed25519 signature (64 bytes) */
  signature: Uint8Array;
  /** Message header */
  header: MessageHeader;
  /** Encrypted payload */
  ciphertext: Uint8Array;
}

// =============================================================================
// Initialization Parameters
// =============================================================================

/**
 * Parameters for initializing session as responder (Bob).
 */
export interface InitResponderParams {
  myAddress: string;
  contactAddress: string;
  /** Ephemeral secret used in HandshakeResponse (becomes dhMySecretKey) */
  myResponderEphemeralSecret: Uint8Array;
  /** = responderEphemeralR on-chain */
  myResponderEphemeralPublic: Uint8Array;
  /** Alice's ephemeral from Handshake event */
  theirHandshakeEphemeralPubKey: Uint8Array;
  topicOutbound: `0x${string}`;
  topicInbound: `0x${string}`;
}

/**
 * Parameters for initializing session as initiator (Alice).
 */
export interface InitInitiatorParams {
  myAddress: string;
  contactAddress: string;
  /** Handshake ephemeral secret (must persist until response arrives) */
  myHandshakeEphemeralSecret: Uint8Array;
  /** 
   * Bob's ratchet ephemeral from INSIDE the decrypted HandshakeResponse payload.
   * NOTE: This is DIFFERENT from the on-chain responderEphemeralR (which is only for tag).
   */
  theirResponderEphemeralPubKey: Uint8Array;
  topicOutbound: `0x${string}`;
  topicInbound: `0x${string}`;
}