// packages/sdk/src/ratchet/index.ts

/**
 * Double Ratchet Module for Verbeth E2EE Messaging.
 * 
 * This module provides bilateral forward secrecy using a Signal-style
 * Double Ratchet protocol adapted for on-chain messaging.
 * 
 * Key Features:
 * - Ephemeral-only initial secret (no identity keys in DH)
 * - Ed25519 signatures for DoS protection
 * - Binary encoding for gas efficiency
 * - Two-phase commit support (immutable session operations)
 * 
 * @example
 * ```typescript
 * import {
 *   initSessionAsResponder,
 *   initSessionAsInitiator,
 *   ratchetEncrypt,
 *   ratchetDecrypt,
 *   verifyMessageSignature,
 *   packageRatchetPayload,
 *   parseRatchetPayload,
 * } from '@verbeth/sdk/ratchet';
 * 
 * // Bob accepts handshake and creates session
 * const bobSession = initSessionAsResponder({
 *   myAddress: bobAddress,
 *   contactAddress: aliceAddress,
 *   myResponderEphemeralSecret: ephemeralSecret,
 *   myResponderEphemeralPublic: ephemeralPublic,
 *   theirHandshakeEphemeralPubKey: aliceEphemeral,
 *   topicOutbound: topics.topicIn,
 *   topicInbound: topics.topicOut,
 * });
 * 
 * // Bob encrypts a message
 * const { session: newSession, header, ciphertext, signature } = ratchetEncrypt(
 *   bobSession,
 *   new TextEncoder().encode('Hello Alice!'),
 *   bobSigningSecretKey
 * );
 * 
 * // Package for on-chain
 * const payload = packageRatchetPayload(signature, header, ciphertext);
 * ```
 */

export {
  
  MAX_SKIP_PER_MESSAGE,
  MAX_STORED_SKIPPED_KEYS,
  MAX_SKIPPED_KEYS_AGE_MS,
  SYNC_BATCH_SIZE,
  RATCHET_VERSION_V1,
  
  type RatchetSession,
  type SkippedKey,
  type SessionStatus,
  type MessageHeader,
  
  type EncryptResult,
  type DecryptResult,
  type ParsedRatchetPayload,
  
  type InitResponderParams,
  type InitInitiatorParams,
} from './types.js';

// KDF functions
export {
  kdfRootKey,
  kdfChainKey,
  dh,
  generateDHKeyPair,
} from './kdf.js';

// Session initialization
export {
  initSessionAsResponder,
  initSessionAsInitiator,
  computeConversationId,
} from './session.js';

// Encryption
export {
  ratchetEncrypt,
  encodeHeader,
} from './encrypt.js';

// Decryption
export {
  ratchetDecrypt,
  pruneExpiredSkippedKeys,
} from './decrypt.js';

// Binary codec
export {
  packageRatchetPayload,
  parseRatchetPayload,
  isRatchetPayload,
  isRatchetPayloadHex,
  hexToBytes,
  bytesToHex,
} from './codec.js';

// Authentication
export {
  verifyMessageSignature,
  signMessage,
  isValidPayloadFormat,
} from './auth.js';