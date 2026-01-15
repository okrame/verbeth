// packages/sdk/src/ratchet/decrypt.ts

/**
 * Ratchet Decryption with Skip Key Handling.
 * - Normal sequential message decryption
 * - DH ratchet steps when sender's DH key changes
 * - Out-of-order messages via skipped keys
 * - Topic ratcheting synchronized with DH ratchet
 */

import nacl from 'tweetnacl';
import { hexlify, getBytes } from 'ethers';
import {
  RatchetSession,
  MessageHeader,
  DecryptResult,
  SkippedKey,
  MAX_SKIP_PER_MESSAGE,
  MAX_STORED_SKIPPED_KEYS,
  TOPIC_TRANSITION_WINDOW_MS,
} from './types.js';
import { kdfRootKey, kdfChainKey, dh, generateDHKeyPair, deriveTopicFromDH } from './kdf.js';

/**
 * Decrypt a message using the ratchet.
 * @param session - Current ratchet session state
 * @param header - Parsed message header
 * @param ciphertext - Encrypted payload (nonce + secretbox output)
 * @returns Decrypt result with new session state and plaintext, or null on failure
 */
export function ratchetDecrypt(
  session: RatchetSession,
  header: MessageHeader,
  ciphertext: Uint8Array
): DecryptResult | null {
  // even authenticated messages shouldn't require insane skips
  const skipNeeded = Math.max(0, header.n - session.receivingMsgNumber);
  if (skipNeeded > MAX_SKIP_PER_MESSAGE || header.pn > MAX_SKIP_PER_MESSAGE) {
    console.error(
      `Message requires ${skipNeeded} skips (pn=${header.pn}) — likely corrupted or malicious peer`
    );
    return null;
  }

  const dhPubHex = hexlify(header.dh);
  const currentTheirDHHex = session.dhTheirPublicKey
    ? hexlify(session.dhTheirPublicKey)
    : null;

  // 1. Try skipped keys first (handles out-of-order messages)
  const skippedResult = trySkippedKeys(session, dhPubHex, header.n, ciphertext);
  if (skippedResult) {
    return skippedResult;
  }

  // 2. Clone session for modifications
  let newSession: RatchetSession = { ...session, skippedKeys: [...session.skippedKeys] };

  // 3. Check if we need to perform a DH ratchet step
  if (dhPubHex !== currentTheirDHHex) {
    if (newSession.receivingChainKey) {
      newSession = skipMessages(newSession, newSession.receivingMsgNumber, header.pn);
    }

    newSession = dhRatchetStep(newSession, header.dh);
  }

  // 4. Skip messages if n > receivingMsgNumber (within current epoch)
  if (header.n > newSession.receivingMsgNumber) {
    newSession = skipMessages(newSession, newSession.receivingMsgNumber, header.n);
  }

  // 5. Derive message key
  if (!newSession.receivingChainKey) {
    console.error('No receiving chain key available');
    return null;
  }

  const { chainKey: newReceivingChainKey, messageKey } = kdfChainKey(
    newSession.receivingChainKey
  );

  // 6. Decrypt
  const plaintext = decryptWithKey(ciphertext, messageKey);

  // 7. Wipe message key
  try {
    messageKey.fill(0);
  } catch {
  }

  if (!plaintext) {
    return null;
  }

  // 8. Update session state
  newSession = {
    ...newSession,
    receivingChainKey: newReceivingChainKey,
    receivingMsgNumber: header.n + 1,
    updatedAt: Date.now(),
  };

  return {
    session: newSession,
    plaintext,
  };
}

/**
 * DH ratchet on receipt of a message that carries a new remote DH public key.
 *
 * Topic derivation is sender centric: `deriveTopicFromDH(x, 'outbound')` denotes the topic used
 * by the party who *sent* the DH pubkey for their sending direction. Therefore, when we ratchet
 * on receive, we swap labels for the topics derived from `dhReceive`.
 */
function dhRatchetStep(session: RatchetSession, theirNewDHPub: Uint8Array): RatchetSession {
  // advance receiving chain (based on our current DH secret and their new DH pubkey)
  const dhReceive = dh(session.dhMySecretKey, theirNewDHPub);
  const { rootKey: rootKey1, chainKey: receivingChainKey } = kdfRootKey(
    session.rootKey,
    dhReceive
  );

  const newDHKeyPair = generateDHKeyPair();

  const dhSend = dh(newDHKeyPair.secretKey, theirNewDHPub);
  const { rootKey: rootKey2, chainKey: sendingChainKey } = kdfRootKey(rootKey1, dhSend);

  const saltBytes = getBytes(session.conversationId);
  
  // Current topics (post ratchet) are swapped since we're the receiver of dhReceive
  const newTopicOut = deriveTopicFromDH(dhReceive, 'inbound', saltBytes);  
  const newTopicIn = deriveTopicFromDH(dhReceive, 'outbound', saltBytes); 

  // Next topics (for our next DH pubkey): normal labels because we will be the sender.
  const nextTopicOut = deriveTopicFromDH(dhSend, 'outbound', saltBytes);
  const nextTopicIn = deriveTopicFromDH(dhSend, 'inbound', saltBytes);

  return {
    ...session,
    rootKey: rootKey2,
    dhMySecretKey: newDHKeyPair.secretKey,
    dhMyPublicKey: newDHKeyPair.publicKey,
    dhTheirPublicKey: theirNewDHPub,
    receivingChainKey,
    receivingMsgNumber: 0,
    sendingChainKey,
    sendingMsgNumber: 0,
    previousChainLength: session.sendingMsgNumber,

    nextTopicOutbound: nextTopicOut,
    nextTopicInbound: nextTopicIn,

    currentTopicOutbound: newTopicOut,
    currentTopicInbound: newTopicIn,
    previousTopicInbound: session.currentTopicInbound,
    previousTopicExpiry: Date.now() + TOPIC_TRANSITION_WINDOW_MS,
    topicEpoch: session.topicEpoch + 1,
  };
}

/**
 * Skip messages by deriving and storing their keys for later out-of-order decryption.
 * Called when:
 * - header.n > receivingMsgNumber (messages skipped in current epoch)
 * - DH ratchet step with header.pn > 0 (messages from previous epoch)
 */
function skipMessages(
  session: RatchetSession,
  start: number,
  until: number
): RatchetSession {
  if (!session.receivingChainKey || until <= start) {
    return session;
  }

  const skippedKeys: SkippedKey[] = [...session.skippedKeys];
  let chainKey = session.receivingChainKey;
  const dhPubHex = hexlify(session.dhTheirPublicKey);
  const now = Date.now();

  for (let i = start; i < until; i++) {
    const { chainKey: newChainKey, messageKey } = kdfChainKey(chainKey);
    skippedKeys.push({
      dhPubKeyHex: dhPubHex,
      msgNumber: i,
      messageKey: new Uint8Array(messageKey),
      createdAt: now,
    });
    chainKey = newChainKey;
  }

  let prunedKeys = skippedKeys;
  if (skippedKeys.length > MAX_STORED_SKIPPED_KEYS) {
    prunedKeys = skippedKeys
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_STORED_SKIPPED_KEYS);
  }

  return {
    ...session,
    receivingChainKey: chainKey,
    skippedKeys: prunedKeys,
  };
}


function trySkippedKeys(
  session: RatchetSession,
  dhPubHex: string,
  msgNumber: number,
  ciphertext: Uint8Array
): DecryptResult | null {
  const idx = session.skippedKeys.findIndex(
    (sk) => sk.dhPubKeyHex === dhPubHex && sk.msgNumber === msgNumber
  );

  if (idx === -1) {
    return null;
  }

  const skippedKey = session.skippedKeys[idx];
  const plaintext = decryptWithKey(ciphertext, skippedKey.messageKey);

  if (!plaintext) {
    return null;
  }

  const newSkippedKeys = [...session.skippedKeys];
  newSkippedKeys.splice(idx, 1);

  // Wipe the key
  try {
    skippedKey.messageKey.fill(0);
  } catch {
  }

  return {
    session: {
      ...session,
      skippedKeys: newSkippedKeys,
      updatedAt: Date.now(),
    },
    plaintext,
  };
}

/**
 * Decrypt ciphertext with message key using XSalsa20-Poly1305.
 * Ciphertext format: nonce (24 bytes) + secretbox output
 */
function decryptWithKey(ciphertext: Uint8Array, messageKey: Uint8Array): Uint8Array | null {
  if (ciphertext.length < nacl.secretbox.nonceLength) {
    return null;
  }

  const nonce = ciphertext.slice(0, nacl.secretbox.nonceLength);
  const box = ciphertext.slice(nacl.secretbox.nonceLength);

  const result = nacl.secretbox.open(box, nonce, messageKey);
  return result || null;
}

/**
 * @param session - Current session
 * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 * @returns Session with pruned skipped keys
 */
export function pruneExpiredSkippedKeys(
  session: RatchetSession,
  maxAgeMs: number = 24 * 60 * 60 * 1000
): RatchetSession {
  const now = Date.now();
  const cutoff = now - maxAgeMs;

  const prunedKeys = session.skippedKeys.filter((sk) => sk.createdAt > cutoff);

  for (const sk of session.skippedKeys) {
    if (sk.createdAt <= cutoff) {
      try {
        sk.messageKey.fill(0);
      } catch {
      }
    }
  }

  if (prunedKeys.length === session.skippedKeys.length) {
    return session; 
  }

  return {
    ...session,
    skippedKeys: prunedKeys,
    updatedAt: now,
  };
}

/**
 * Check if topic matches this session.
 * Returns match type or null.
 * 
 * @param session - Ratchet session to check
 * @param topic - Topic to match against
 * @returns 'current' if matches current inbound, 'previous' if matches previous (within grace), null otherwise
 */
export function matchesSessionTopic(
  session: RatchetSession,
  topic: `0x${string}`
): 'current' | 'previous' | null {
  const t = topic.toLowerCase();

  if (session.currentTopicInbound.toLowerCase() === t) {
    return 'current';
  }

  if (
    session.previousTopicInbound?.toLowerCase() === t &&
    session.previousTopicExpiry &&
    Date.now() < session.previousTopicExpiry
  ) {
    return 'previous';
  }

  return null;
}