// packages/sdk/src/ratchet/session.ts

/**
 * Ratchet Session Initialization.
 * Initial shared secret is derived from ephemeral to ephemeral DH only.
 */

import { keccak256, toUtf8Bytes, getBytes } from 'ethers';
import { 
  RatchetSession, 
  InitResponderParams, 
  InitInitiatorParams,
} from './types.js';
import { kdfRootKey, dh, generateDHKeyPair, deriveTopicFromDH } from './kdf.js';

/**
 * Compute deterministic conversation ID from topics.
 * Sorting ensures both parties derive the same ID regardless of perspective.
 */
export function computeConversationId(topicA: string, topicB: string): string {
  const sorted = [topicA.toLowerCase(), topicB.toLowerCase()].sort();
  return keccak256(toUtf8Bytes(sorted.join(':')));
}

/**
 * Called after receiving handshake, before/during sending response.
 * The responder must persist myResponderEphemeralSecret immediately.
 * This becomes dhMySecretKey and is required for all future ratchet operations.
 * 
 * Responder starts at epoch 0 (handshake topics).
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
    dhMySecretKey: myResponderEphemeralSecret,
    dhMyPublicKey: myResponderEphemeralPublic,
    dhTheirPublicKey: theirHandshakeEphemeralPubKey,

    sendingChainKey,
    sendingMsgNumber: 0,

    // Receiving chain not yet established
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
 * Called after receiving and validating handshake response.
 * 
 * Initiator precomputes epoch 1 topics from its first post handshake DH step.
 * Outbound should use epoch 1 as soon as we introduce a new DH pubkey.
 * Inbound stays on epoch 0 until the responder ratchets.
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

  const sharedSecret = dh(myHandshakeEphemeralSecret, theirResponderEphemeralPubKey);

  // Derive same initial root key as responder
  const { rootKey: initialRootKey, chainKey: bobsSendingChain } = kdfRootKey(
    new Uint8Array(32),
    sharedSecret
  );

  // Generate first DH keypair for sending
  const myDHKeyPair = generateDHKeyPair();

  const dhSend = dh(myDHKeyPair.secretKey, theirResponderEphemeralPubKey);
  const { rootKey: finalRootKey, chainKey: sendingChainKey } = kdfRootKey(
    initialRootKey,
    dhSend
  );

  const conversationId = computeConversationId(topicOutbound, topicInbound);
  const saltBytes = getBytes(conversationId);
  const epoch1TopicOut = deriveTopicFromDH(dhSend, 'outbound', saltBytes);
  const epoch1TopicIn = deriveTopicFromDH(dhSend, 'inbound', saltBytes);

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
    receivingChainKey: bobsSendingChain,
    receivingMsgNumber: 0,

    previousChainLength: 0,
    skippedKeys: [],

    currentTopicOutbound: topicOutbound,
    currentTopicInbound: topicInbound,

    nextTopicOutbound: epoch1TopicOut,
    nextTopicInbound: epoch1TopicIn,
    topicEpoch: 0,

    createdAt: now,
    updatedAt: now,
    epoch: 0,
  };
}