// packages/sdk/src/ratchet/session.ts

/**
 * Ratchet Session Initialization.
 * 
 * Provides functions to initialize ratchet sessions for both
 * initiator (Alice) and responder (Bob) roles.
 * 
 * Initial shared secret is derived from ephemeral-to-ephemeral DH only.
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import {
  RatchetSession,
  InitResponderParams,
  InitInitiatorParams,
} from './types.js';
import { kdfRootKey, dh, generateDHKeyPair, deriveTopic, hybridInitialSecret } from './kdf.js';

/**
 * Compute deterministic conversation ID from topics.
 * Sorting ensures both parties derive the same ID regardless of perspective.
 * 
 * @param topicA - First topic
 * @param topicB - Second topic
 * @returns Unique conversation identifier
 */
export function computeConversationId(topicA: string, topicB: string): string {
  const sorted = [topicA.toLowerCase(), topicB.toLowerCase()].sort();
  return keccak256(toUtf8Bytes(sorted.join(':')));
}

/**
 * Initialize session as responder (Bob).
 *
 * Called after receiving handshake, before/during sending response.
 * The responder must persist myResponderEphemeralSecret immediately.
 * This becomes dhMySecretKey and is required for all future ratchet operations.
 *
 * Responder starts at epoch 0 (handshake topics).
 *
 * If kemSecret is provided (from ML-KEM encapsulation), uses hybrid KDF
 * combining X25519 DH and ML-KEM for post-quantum security.
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
    kemSecret,
  } = params;

  const x25519Secret = dh(myResponderEphemeralSecret, theirHandshakeEphemeralPubKey);

  const sharedSecret = kemSecret
    ? hybridInitialSecret(x25519Secret, kemSecret)
    : x25519Secret;

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
    dhMySecretKey: myResponderEphemeralSecret,
    dhMyPublicKey: myResponderEphemeralPublic,
    dhTheirPublicKey: theirHandshakeEphemeralPubKey,

    sendingChainKey,
    sendingMsgNumber: 0,

    // Receiving chain not yet established (Alice sends first post-handshake)
    receivingChainKey: null,
    receivingMsgNumber: 0,

    previousChainLength: 0,
    skippedKeys: [],

    // Topic Ratcheting - Epoch 0: use handshake-derived topics
    currentTopicOutbound: topicOutbound,
    currentTopicInbound: topicInbound,
    previousTopicInbound: undefined,
    previousTopicExpiry: undefined,
    topicEpoch: 0,

    createdAt: now,
    updatedAt: now,
    epoch: 0,
  };
}

/**
 * Initialize session as initiator (Alice).
 *
 * Called after receiving and validating handshake response.
 *
 * Initiator precomputes epoch 1 topics from its first post-handshake DH step.
 * Outbound should use epoch 1 as soon as we introduce a new DH pubkey.
 * Inbound stays on epoch 0 until the responder ratchets.
 *
 * If kemSecret is provided (from ML-KEM decapsulation), uses hybrid KDF
 * combining X25519 DH and ML-KEM for post-quantum security.
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
    kemSecret,
  } = params;

  const x25519Secret = dh(myHandshakeEphemeralSecret, theirResponderEphemeralPubKey);

  const sharedSecret = kemSecret
    ? hybridInitialSecret(x25519Secret, kemSecret)
    : x25519Secret;

  // Derive same initial root key as responder
  const { rootKey: initialRootKey, chainKey: bobsSendingChain } = kdfRootKey(
    new Uint8Array(32),
    sharedSecret
  );

  // Generate first DH keypair for sending (Alice performs first DH ratchet)
  const myDHKeyPair = generateDHKeyPair();

  const dhSend = dh(myDHKeyPair.secretKey, theirResponderEphemeralPubKey);
  const { rootKey: finalRootKey, chainKey: sendingChainKey } = kdfRootKey(
    initialRootKey,
    dhSend
  );

  const conversationId = computeConversationId(topicOutbound, topicInbound);

  // Pre-compute epoch 1 topics (for when our first message is sent)
  // Use finalRootKey as PQ-secure salt for quantum-resistant topic unlinkability
  const epoch1TopicOut = deriveTopic(finalRootKey, dhSend, 'outbound');
  const epoch1TopicIn = deriveTopic(finalRootKey, dhSend, 'inbound');

  const now = Date.now();

  return {
    conversationId,
    topicOutbound,
    topicInbound,
    myAddress,
    contactAddress,

    rootKey: finalRootKey,
    dhMySecretKey: myDHKeyPair.secretKey,
    dhMyPublicKey: myDHKeyPair.publicKey,
    dhTheirPublicKey: theirResponderEphemeralPubKey,

    sendingChainKey,
    sendingMsgNumber: 0,
    
    // Alice can receive Bob's messages immediately
    receivingChainKey: bobsSendingChain,
    receivingMsgNumber: 0,

    previousChainLength: 0,
    skippedKeys: [],

    // Start with handshake topics
    currentTopicOutbound: topicOutbound,
    currentTopicInbound: topicInbound,

    // Pre-computed next topics (will be promoted when we send)
    nextTopicOutbound: epoch1TopicOut,
    nextTopicInbound: epoch1TopicIn,
    topicEpoch: 0,

    createdAt: now,
    updatedAt: now,
    epoch: 0,
  };
}