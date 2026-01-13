// packages/sdk/src/ratchet/auth.ts

/**
 * Message Authentication for Ratchet Protocol.
 */

import nacl from 'tweetnacl';
import { MessageHeader } from './types.js';

// =============================================================================
// Signature Verification
// =============================================================================

/**
 * Verify message signature before any ratchet operations.
 * This is the primary DoS protection layer.
 * 
 * The signature covers (header || ciphertext), where header is the 40-byte
 * binary encoding of (dh, pn, n).
 * 
 * @param signature - Ed25519 signature (64 bytes)
 * @param header - Message header
 * @param ciphertext - Encrypted payload
 * @param signingPublicKey - Contact's Ed25519 public key (32 bytes)
 * @returns true if signature is valid
 */
export function verifyMessageSignature(
  signature: Uint8Array,
  header: MessageHeader,
  ciphertext: Uint8Array,
  signingPublicKey: Uint8Array
): boolean {
  if (signature.length !== 64) {
    return false;
  }
  if (signingPublicKey.length !== 32) {
    return false;
  }

  // Reconstruct signed data: header || ciphertext
  const headerBytes = encodeHeaderForSigning(header);
  const dataToVerify = new Uint8Array(headerBytes.length + ciphertext.length);
  dataToVerify.set(headerBytes, 0);
  dataToVerify.set(ciphertext, headerBytes.length);

  try {
    return nacl.sign.detached.verify(dataToVerify, signature, signingPublicKey);
  } catch {
    return false;
  }
}

/**
 * Encode header as 40 bytes for signature verification.
 */
function encodeHeaderForSigning(header: MessageHeader): Uint8Array {
  const buf = new Uint8Array(40);
  buf.set(header.dh, 0);
  new DataView(buf.buffer).setUint32(32, header.pn, false); // big-endian
  new DataView(buf.buffer).setUint32(36, header.n, false);
  return buf;
}

// =============================================================================
// Signature Creation (for completeness - also in encrypt.ts)
// =============================================================================

/**
 * Create Ed25519 signature for a message.
 * 
 * @param header - Message header
 * @param ciphertext - Encrypted payload
 * @param signingSecretKey - Ed25519 secret key (64 bytes)
 * @returns Ed25519 signature (64 bytes)
 */
export function signMessage(
  header: MessageHeader,
  ciphertext: Uint8Array,
  signingSecretKey: Uint8Array
): Uint8Array {
  const headerBytes = encodeHeaderForSigning(header);
  const dataToSign = new Uint8Array(headerBytes.length + ciphertext.length);
  dataToSign.set(headerBytes, 0);
  dataToSign.set(ciphertext, headerBytes.length);

  return nacl.sign.detached(dataToSign, signingSecretKey);
}

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validate that a parsed payload has a well-formed signature and header.
 * Does NOT verify the signature - just checks lengths and format.
 * 
 * @param signature - Signature bytes
 * @param header - Parsed header
 * @returns true if format is valid
 */
export function isValidPayloadFormat(
  signature: Uint8Array,
  header: MessageHeader
): boolean {
  return (
    signature.length === 64 &&
    header.dh.length === 32 &&
    header.pn >= 0 &&
    header.n >= 0 &&
    Number.isInteger(header.pn) &&
    Number.isInteger(header.n)
  );
}