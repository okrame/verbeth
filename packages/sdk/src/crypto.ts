// packages/sdk/src/crypto.ts
// CLEANED VERSION - duplexTopics and legacy functions removed

/**
 * Cryptographic utilities for Verbeth.
 * 
 * This module handles:
 * - Handshake encryption/decryption (NaCl box - one-time exchange)
 * - Tag computation for handshake responses
 * 
 * NOTE: Post-handshake message encryption uses the ratchet module.
 * See `ratchet/encrypt.ts` and `ratchet/decrypt.ts` for Double Ratchet.
 * 
 * NOTE: Topic derivation is now handled entirely by the ratchet module.
 * See `ratchet/kdf.ts` for `deriveTopicFromDH`.
 */

import nacl from 'tweetnacl';
import { keccak256, toUtf8Bytes } from 'ethers';
import { sha256 } from '@noble/hashes/sha2';
import { hkdf } from '@noble/hashes/hkdf';
import {
  encodePayload,
  decodePayload,
  encodeStructuredContent,
  decodeStructuredContent,
  HandshakeResponseContent,
  extractKeysFromHandshakeResponse
} from './payload.js';
import { IdentityProof } from './types.js'; 

// =============================================================================
// Handshake Encryption (NaCl Box)
// =============================================================================

/**
 * Encrypts a structured payload (JSON-serializable objects) using NaCl box.
 * Used for handshake responses where ratchet is not yet established.
 */
export function encryptStructuredPayload<T>(
  payload: T,
  recipientPublicKey: Uint8Array,
  ephemeralSecretKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  staticSigningSecretKey?: Uint8Array,
  staticSigningPublicKey?: Uint8Array
): string {
  // encode payload as binary JSON
  const plaintext = encodeStructuredContent(payload);
  
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(plaintext, nonce, recipientPublicKey, ephemeralSecretKey);

  let sig;
  if (staticSigningSecretKey && staticSigningPublicKey) {
    const dataToSign = Buffer.concat([ephemeralPublicKey, nonce, box]);
    sig = nacl.sign.detached(dataToSign, staticSigningSecretKey);
  }

  return encodePayload(ephemeralPublicKey, nonce, box, sig);
}

/**
 * Decrypts a structured payload with converter function.
 * Used for handshake responses where ratchet is not yet established.
 */
export function decryptStructuredPayload<T>(
  payloadJson: string,
  recipientSecretKey: Uint8Array,
  converter: (obj: any) => T,
  staticSigningPublicKey?: Uint8Array
): T | null {
  const { epk, nonce, ciphertext, sig } = decodePayload(payloadJson);

  if (sig && staticSigningPublicKey) {
    const dataToVerify = Buffer.concat([epk, nonce, ciphertext]);
    const valid = nacl.sign.detached.verify(dataToVerify, sig, staticSigningPublicKey);
    if (!valid) return null;
  }

  const box = nacl.box.open(ciphertext, nonce, epk, recipientSecretKey);
  if (!box) return null;
  
  return decodeStructuredContent(box, converter);
}

// =============================================================================
// Handshake Response Decryption
// =============================================================================

/**
 * Decrypts handshake response and extracts individual keys from unified format.
 */
export function decryptHandshakeResponse(
  payloadJson: string,
  initiatorEphemeralSecretKey: Uint8Array
): HandshakeResponseContent | null {
  return decryptStructuredPayload<HandshakeResponseContent>(
    payloadJson,
    initiatorEphemeralSecretKey,
    (obj: any): HandshakeResponseContent => {
      if (!obj.identityProof) {
        throw new Error("Invalid handshake response: missing identityProof");
      }
      return {
        unifiedPubKeys: Uint8Array.from(Buffer.from(obj.unifiedPubKeys, 'base64')),
        ephemeralPubKey: Uint8Array.from(Buffer.from(obj.ephemeralPubKey, 'base64')),
        ...(obj.kemCiphertext && { kemCiphertext: Uint8Array.from(Buffer.from(obj.kemCiphertext, 'base64')) }),
        note: obj.note,
        identityProof: obj.identityProof,
        // topicInfo removed - no longer needed
      };
    }
  );
}

/**
 * Helper to decrypt handshake response and extract individual keys.
 */
export function decryptAndExtractHandshakeKeys(
  payloadJson: string,
  initiatorEphemeralSecretKey: Uint8Array
): {
  identityPubKey: Uint8Array;
  signingPubKey: Uint8Array;
  ephemeralPubKey: Uint8Array;
  kemCiphertext?: Uint8Array;
  note?: string;
  identityProof: IdentityProof;
} | null {
  const decrypted = decryptHandshakeResponse(payloadJson, initiatorEphemeralSecretKey);
  if (!decrypted) return null;

  const extracted = extractKeysFromHandshakeResponse(decrypted);
  if (!extracted) return null;

  return {
    identityPubKey: extracted.identityPubKey,
    signingPubKey: extracted.signingPubKey,
    ephemeralPubKey: extracted.ephemeralPubKey,
    kemCiphertext: decrypted.kemCiphertext,
    note: decrypted.note,
    identityProof: decrypted.identityProof
  };
}

// =============================================================================
// Tag Computation (Handshake Response Linkage)
// =============================================================================

/**
 * HKDF(sha256) on shared secret, info="verbeth:hsr", then Keccak-256 -> bytes32 (0x...)
 */
function finalizeHsrTag(shared: Uint8Array): `0x${string}` {
  const okm = hkdf(sha256, shared, new Uint8Array(0), toUtf8Bytes("verbeth:hsr"), 32);
  return keccak256(okm) as `0x${string}`;
}

/**
 * Responder: tag = H( KDF( ECDH(r, viewPubA), "verbeth:hsr"))
 */
export function computeTagFromResponder(
  rSecretKey: Uint8Array,
  viewPubA: Uint8Array
): `0x${string}` {
  const shared = nacl.scalarMult(rSecretKey, viewPubA);
  return finalizeHsrTag(shared);
}

/**
 * Initiator: tag = H( KDF( ECDH(viewPrivA, R), "verbeth:hsr"))
 */
export function computeTagFromInitiator(
  viewPrivA: Uint8Array,
  R: Uint8Array
): `0x${string}` {
  const shared = nacl.scalarMult(viewPrivA, R);
  return finalizeHsrTag(shared);
}

// =============================================================================
// Hybrid Tag Computation (PQ-Secure)
// =============================================================================

function finalizeHybridHsrTag(kemSecret: Uint8Array, ecdhShared: Uint8Array): `0x${string}` {
  const okm = hkdf(sha256, kemSecret, ecdhShared, toUtf8Bytes("verbeth:hsr-hybrid:v1"), 32);
  return keccak256(okm) as `0x${string}`;
}

export function computeHybridTagFromResponder(
  rSecretKey: Uint8Array,
  viewPubA: Uint8Array,
  kemSecret: Uint8Array
): `0x${string}` {
  const ecdhShared = nacl.scalarMult(rSecretKey, viewPubA);
  return finalizeHybridHsrTag(kemSecret, ecdhShared);
}

export function computeHybridTagFromInitiator(
  viewPrivA: Uint8Array,
  R: Uint8Array,
  kemSecret: Uint8Array
): `0x${string}` {
  const ecdhShared = nacl.scalarMult(viewPrivA, R);
  return finalizeHybridHsrTag(kemSecret, ecdhShared);
}

// =============================================================================
// REMOVED FUNCTIONS:
// =============================================================================
// 
// deriveLongTermShared() - was used for duplexTopics, now use ratchet/kdf.ts dh()
// deriveDuplexTopics() - replaced by deriveTopicFromDH() in ratchet/kdf.ts
// verifyDuplexTopicsChecksum() - no longer needed, topics derive from DH
// encryptMessage() - deprecated, use ratchetEncrypt() from ratchet module
// decryptMessage() - deprecated, use ratchetDecrypt() from ratchet module
//
// =============================================================================