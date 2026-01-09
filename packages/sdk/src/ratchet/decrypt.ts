// packages/sdk/src/ratchet/decrypt.ts

/**
 * Ratchet Decryption with Skip Key Handling.
 * 
 * Handles:
 * - Normal sequential message decryption
 * - DH ratchet steps when sender's DH key changes
 * - Out-of-order messages via skipped keys
 * 
 * N.b: Caller must verify Ed25519 signature before calling this function.
 * This function assumes the message is authenticated.
 */

import nacl from 'tweetnacl';
import { hexlify } from 'ethers';
import {
  RatchetSession,
  MessageHeader,
  DecryptResult,
  SkippedKey,
  MAX_SKIP_PER_MESSAGE,
  MAX_STORED_SKIPPED_KEYS,
} from './types.js';
import { kdfRootKey, kdfChainKey, dh, generateDHKeyPair } from './kdf.js';

// =============================================================================
// Main Decrypt Function
// =============================================================================

/**
 * Decrypt a message using the ratchet.
 * 
 * Handles DH ratchet steps and out-of-order messages (skip keys).
 * Returns updated session state and plaintext, or null if decryption fails.
 * 
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
  // Sanity check: even authenticated messages shouldn't require insane skips
  // This protects against malicious peers or corrupted state
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
    // Skip remaining messages on current receiving chain (if any)
    if (newSession.receivingChainKey) {
      newSession = skipMessages(newSession, newSession.receivingMsgNumber, header.pn);
    }

    // Perform DH ratchet
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
    // Some environments may not allow filling typed arrays
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

// =============================================================================
// DH Ratchet Step
// =============================================================================

/**
 * Perform a DH ratchet step when receiving a message with a new DH public key.
 * 
 * This advances both the receiving and sending chains:
 * 1. Receiving DH: derive new receiving chain from DH(mySecret, theirNewPub)
 * 2. Generate new DH keypair for sending
 * 3. Sending DH: derive new sending chain from DH(newSecret, theirNewPub)
 */
function dhRatchetStep(session: RatchetSession, theirNewDHPub: Uint8Array): RatchetSession {
  // Receiving DH: use our current secret with their new public
  const dhReceive = dh(session.dhMySecretKey, theirNewDHPub);
  const { rootKey: rootKey1, chainKey: receivingChainKey } = kdfRootKey(
    session.rootKey,
    dhReceive
  );

  // Generate new DH keypair for sending
  const newDHKeyPair = generateDHKeyPair();

  // Sending DH: use new secret with their new public
  const dhSend = dh(newDHKeyPair.secretKey, theirNewDHPub);
  const { rootKey: rootKey2, chainKey: sendingChainKey } = kdfRootKey(rootKey1, dhSend);

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
  };
}

// =============================================================================
// Skip Key Management
// =============================================================================

/**
 * Skip messages by deriving and storing their keys for later out-of-order decryption.
 * 
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

  // Derive and store skipped keys
  for (let i = start; i < until; i++) {
    const { chainKey: newChainKey, messageKey } = kdfChainKey(chainKey);
    skippedKeys.push({
      dhPubKeyHex: dhPubHex,
      msgNumber: i,
      messageKey: new Uint8Array(messageKey), // Copy to avoid reference issues
      createdAt: now,
    });
    chainKey = newChainKey;
  }

  // Prune if exceeds storage limit (keep newest)
  let prunedKeys = skippedKeys;
  if (skippedKeys.length > MAX_STORED_SKIPPED_KEYS) {
    // Sort by createdAt descending, keep newest
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

/**
 * Try to decrypt using stored skipped keys.
 * Returns decrypt result if found, null otherwise.
 */
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

  // Remove used key from list
  const newSkippedKeys = [...session.skippedKeys];
  newSkippedKeys.splice(idx, 1);

  // Wipe the key
  try {
    skippedKey.messageKey.fill(0);
  } catch {
    // Some environments may not allow filling typed arrays
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

// =============================================================================
// Low-Level Decryption
// =============================================================================

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

// =============================================================================
// Utility: Prune Expired Skipped Keys
// =============================================================================

/**
 * Remove skipped keys older than MAX_SKIPPED_KEYS_AGE_MS.
 * Should be called periodically (e.g., on session load or after decrypt).
 * 
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
        // typed array fill may not be supported
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