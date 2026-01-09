// packages/sdk/src/ratchet/session.ts

/**
 * Ratchet Session Initialization.
 * 
 * CRITICAL DESIGN: Initial shared secret is derived from ephemeral↔ephemeral DH ONLY.
 * NO identity keys are used in secret derivation. This ensures that compromise of
 * identity keys NEVER allows decryption of past messages, not even the first one.
 * 
 * Authentication is provided separately via Ed25519 signatures on every message.
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import { 
  RatchetSession, 
  InitResponderParams, 
  InitInitiatorParams 
} from './types.js';
import { kdfRootKey, dh, generateDHKeyPair } from './kdf.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Compute deterministic conversation ID from topics.
 * Sorting ensures both parties derive the same ID regardless of perspective.
 */
export function computeConversationId(topicA: string, topicB: string): string {
  const sorted = [topicA.toLowerCase(), topicB.toLowerCase()].sort();
  return keccak256(toUtf8Bytes(sorted.join(':')));
}

// =============================================================================
// Session Initialization
// =============================================================================

/**
 * Initialize session as RESPONDER (Bob).
 * Called after receiving handshake, before/during sending response.
 * 
 * Bob reuses his HandshakeResponse ephemeral key (responderEphemeralR) as his
 * first DH ratchet key. This avoids adding new fields to the on-chain format.
 * 
 * ⚠️ CRITICAL: The responder MUST persist myResponderEphemeralSecret immediately.
 * This becomes dhMySecretKey and is required for all future ratchet operations.
 * 
 * @param params - Initialization parameters
 * @returns Initialized ratchet session
 */
export function initSessionAsResponder(params: InitResponderParams): RatchetSession {
  const {
    myAddress,
    contactAddress,
    myResponderEphemeralSecret,
    myResponderEphemeralPublic,
    theirHandshakeEphemeralPubKey,
    topicOutbound,
    topicInbound,
  } = params;

  // Initial shared secret: DH(myEphemeral, theirEphemeral) ONLY
  // NO identity keys → true forward secrecy from message 0
  const sharedSecret = dh(myResponderEphemeralSecret, theirHandshakeEphemeralPubKey);

  // Derive initial root key and sending chain key
  const { rootKey, chainKey: sendingChainKey } = kdfRootKey(
    new Uint8Array(32), // Initial salt (zeros)
    sharedSecret
  );

  const now = Date.now();

  return {
    conversationId: computeConversationId(topicOutbound, topicInbound),
    topicOutbound,
    topicInbound,
    myAddress,
    contactAddress,

    rootKey,

    // Reuse responder ephemeral as first DH ratchet key
    // This is already on-chain as responderEphemeralR
    dhMySecretKey: myResponderEphemeralSecret,
    dhMyPublicKey: myResponderEphemeralPublic,
    dhTheirPublicKey: theirHandshakeEphemeralPubKey,

    // Bob can send immediately using sendingChainKey
    sendingChainKey,
    sendingMsgNumber: 0,

    // Receiving chain not yet established (Alice hasn't sent with her new DH key)
    receivingChainKey: null,
    receivingMsgNumber: 0,

    previousChainLength: 0,
    skippedKeys: [],

    createdAt: now,
    updatedAt: now,
    epoch: 0,
    status: 'active',
  };
}

/**
 * Initialize session as INITIATOR (Alice).
 * Called after receiving and validating handshake response.
 * 
 * Alice performs an immediate DH ratchet step upon initialization because
 * Bob's ratchet ephemeral (from inside the decrypted payload) is his first DH public key.
 * 
 * IMPORTANT: theirResponderEphemeralPubKey comes from INSIDE the decrypted
 * HandshakeResponse payload, NOT from the on-chain responderEphemeralR field.
 * The on-chain R is only used for tag verification and is different for unlinkability.
 * 
 * @param params - Initialization parameters
 * @returns Initialized ratchet session
 */
export function initSessionAsInitiator(params: InitInitiatorParams): RatchetSession {
  const {
    myAddress,
    contactAddress,
    myHandshakeEphemeralSecret,
    theirResponderEphemeralPubKey,
    topicOutbound,
    topicInbound,
  } = params;

  // Initial shared secret: DH(myEphemeral, theirEphemeral) ONLY
  // This matches what Bob computed: DH(bobEphemeral, aliceEphemeral)
  const sharedSecret = dh(myHandshakeEphemeralSecret, theirResponderEphemeralPubKey);

  // Derive same initial root key as Bob
  const { rootKey: initialRootKey, chainKey: bobsSendingChain } = kdfRootKey(
    new Uint8Array(32), // Same initial salt
    sharedSecret
  );
  // Note: bobsSendingChain is Bob's sending chain = Alice's receiving chain

  // Generate Alice's first DH keypair for sending
  const myDHKeyPair = generateDHKeyPair();

  // Perform sending ratchet step (Alice does this immediately)
  const dhSend = dh(myDHKeyPair.secretKey, theirResponderEphemeralPubKey);
  const { rootKey: finalRootKey, chainKey: sendingChainKey } = kdfRootKey(
    initialRootKey,
    dhSend
  );

  const now = Date.now();

  return {
    conversationId: computeConversationId(topicOutbound, topicInbound),
    topicOutbound,
    topicInbound,
    myAddress,
    contactAddress,

    rootKey: finalRootKey,

    // Alice's newly generated DH keypair
    dhMySecretKey: myDHKeyPair.secretKey,
    dhMyPublicKey: myDHKeyPair.publicKey,
    // Bob's responder ephemeral is his first DH public key
    dhTheirPublicKey: theirResponderEphemeralPubKey,

    sendingChainKey,
    sendingMsgNumber: 0,

    // Alice's receiving chain = Bob's sending chain (from initial secret)
    receivingChainKey: bobsSendingChain,
    receivingMsgNumber: 0,

    previousChainLength: 0,
    skippedKeys: [],

    createdAt: now,
    updatedAt: now,
    epoch: 0,
    status: 'active',
  };
}