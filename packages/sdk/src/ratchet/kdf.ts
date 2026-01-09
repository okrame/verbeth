// packages/sdk/src/ratchet/kdf.ts

/**
 * Key Derivation Functions for Double Ratchet.
 * 
 * Uses HKDF-SHA256 for root key derivation and HMAC-SHA256 for chain key derivation,
 * matching Signal protocol specifications.
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import nacl from 'tweetnacl';

// =============================================================================
// Root Key Derivation
// =============================================================================

/**
 * Derive new root key and chain key from DH output.
 * Called on every DH ratchet step.
 * 
 * KDF_RK(rk, dh_out) = HKDF(dh_out, rk, "VerbethRatchet", 64)
 *   → (new_rk[0:32], chain_key[32:64])
 * 
 * @param rootKey - Current root key (32 bytes)
 * @param dhOutput - DH shared secret (32 bytes)
 * @returns New root key and chain key
 */
export function kdfRootKey(
  rootKey: Uint8Array,
  dhOutput: Uint8Array
): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const output = hkdf(sha256, dhOutput, rootKey, 'VerbethRatchet', 64);
  return {
    rootKey: output.slice(0, 32),
    chainKey: output.slice(32, 64),
  };
}

// =============================================================================
// Chain Key Derivation
// =============================================================================

/**
 * Derive message key and advance chain key.
 * Called for every message sent/received.
 * 
 * KDF_CK(ck) = (HMAC(ck, 0x02), HMAC(ck, 0x01))
 *   → (new_chain_key, message_key)
 * 
 * @param chainKey - Current chain key (32 bytes)
 * @returns New chain key and message key for encryption/decryption
 */
export function kdfChainKey(
  chainKey: Uint8Array
): { chainKey: Uint8Array; messageKey: Uint8Array } {
  // Message key derived with constant 0x01
  const messageKey = hmac(sha256, chainKey, new Uint8Array([0x01]));
  // New chain key derived with constant 0x02
  const newChainKey = hmac(sha256, chainKey, new Uint8Array([0x02]));
  
  return {
    chainKey: newChainKey,
    messageKey: messageKey,
  };
}

// =============================================================================
// Diffie-Hellman Operations
// =============================================================================

/**
 * Perform X25519 Diffie-Hellman key exchange.
 * 
 * @param mySecretKey - My X25519 secret key (32 bytes)
 * @param theirPublicKey - Their X25519 public key (32 bytes)
 * @returns Shared secret (32 bytes)
 */
export function dh(
  mySecretKey: Uint8Array,
  theirPublicKey: Uint8Array
): Uint8Array {
  return nacl.scalarMult(mySecretKey, theirPublicKey);
}

/**
 * Generate new X25519 keypair for DH ratchet step.
 * 
 * @returns New keypair with secretKey and publicKey
 */
export function generateDHKeyPair(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const kp = nacl.box.keyPair();
  return { secretKey: kp.secretKey, publicKey: kp.publicKey };
}