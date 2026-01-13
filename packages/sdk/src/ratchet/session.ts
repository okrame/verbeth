// packages/sdk/src/ratchet/session.ts

/**
 * Ratchet Session Initialization.
 * Initial shared secret is derived from ephemeral to ephemeral DH only.
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import { 
  RatchetSession, 
  InitResponderParams, 
  InitInitiatorParams 
} from './types.js';
import { kdfRootKey, dh, generateDHKeyPair } from './kdf.js';

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
    // This is already on-chain as responderEphemeralR
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

    createdAt: now,
    updatedAt: now,
    epoch: 0,
  };
}

/**
 * Called after receiving and validating handshake response.
 * 
 * NB: theirResponderEphemeralPubKey comes from inside the decrypted
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

  const sharedSecret = dh(myHandshakeEphemeralSecret, theirResponderEphemeralPubKey);

  // Derive same initial root key as hs responder
  const { rootKey: initialRootKey, chainKey: bobsSendingChain } = kdfRootKey(
    new Uint8Array(32), // Same initial salt
    sharedSecret
  );

  // Generate first DH keypair for sending
  const myDHKeyPair = generateDHKeyPair();

  // Perform sending ratchet step
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

    dhMySecretKey: myDHKeyPair.secretKey,
    dhMyPublicKey: myDHKeyPair.publicKey,

    dhTheirPublicKey: theirResponderEphemeralPubKey,

    sendingChainKey,
    sendingMsgNumber: 0,

    receivingChainKey: bobsSendingChain,
    receivingMsgNumber: 0,

    previousChainLength: 0,
    skippedKeys: [],

    createdAt: now,
    updatedAt: now,
    epoch: 0,
  };
}