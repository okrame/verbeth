// packages/sdk/src/ratchet/encrypt.ts

/**
 * Ratchet Encryption.
 * 
 * Encrypts plaintext using the current sending chain, advances chain state,
 * and signs the message with Ed25519.
 * 
 * Returns a new session object. Caller must not persist until
 * the tx is confirmed on-chain (two-phase commit pattern).
 */

import nacl from 'tweetnacl';
import { RatchetSession, MessageHeader, EncryptResult } from './types.js';
import { kdfChainKey } from './kdf.js';

/**
 * Encode message header as 40 bytes for signing.
 * Format: dh (32) + pn (4, BE) + n (4, BE)
 */
export function encodeHeader(header: MessageHeader): Uint8Array {
  const buf = new Uint8Array(40);
  buf.set(header.dh, 0);
  new DataView(buf.buffer).setUint32(32, header.pn, false); // big-endian
  new DataView(buf.buffer).setUint32(36, header.n, false);
  return buf;
}

/** 
 * @param session - Current ratchet session state
 * @param plaintext - Message to encrypt
 * @param signingSecretKey - Ed25519 secret key for signing (64 bytes)
 * @returns Encrypt result with new session state, header, ciphertext, and signature
 * @throws If session is not ready to send (no sending chain key)
 */
export function ratchetEncrypt(
  session: RatchetSession,
  plaintext: Uint8Array,
  signingSecretKey: Uint8Array
): EncryptResult {
  if (!session.sendingChainKey) {
    throw new Error('Session not ready to send (no sending chain key)');
  }

  // 1. Advance sending chain to get message key
  const { chainKey: newChainKey, messageKey } = kdfChainKey(session.sendingChainKey);

  // 2. Create header with current DH public key and message numbers
  const header: MessageHeader = {
    dh: session.dhMyPublicKey,
    pn: session.previousChainLength,
    n: session.sendingMsgNumber,
  };

  // 3. Encrypt with message key using XSalsa20-Poly1305
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength); // 24 bytes
  const ciphertext = nacl.secretbox(plaintext, nonce, messageKey);

  // 4. Combine nonce + ciphertext
  const encryptedPayload = new Uint8Array(nonce.length + ciphertext.length);
  encryptedPayload.set(nonce, 0);
  encryptedPayload.set(ciphertext, nonce.length);

  // 5. Sign (header || encryptedPayload) with Ed25519
  const headerBytes = encodeHeader(header);
  const dataToSign = new Uint8Array(headerBytes.length + encryptedPayload.length);
  dataToSign.set(headerBytes, 0);
  dataToSign.set(encryptedPayload, headerBytes.length);

  const signature = nacl.sign.detached(dataToSign, signingSecretKey);

  // 6. Create new session state (don't mutate original)
  const newSession: RatchetSession = {
    ...session,
    sendingChainKey: newChainKey,
    sendingMsgNumber: session.sendingMsgNumber + 1,
    updatedAt: Date.now(),
  };

  // 7. Wipe message key from memory
  try {
    messageKey.fill(0);
  } catch {
  }

  return {
    session: newSession,
    header,
    ciphertext: encryptedPayload,
    signature,
  };
}