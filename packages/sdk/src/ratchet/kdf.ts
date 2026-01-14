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
import { keccak256 } from 'ethers';
import nacl from 'tweetnacl';

/**
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

/**
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

/**
 * Derive topic from DH shared secret.
 * Called after each DH ratchet step to rotate topics.
 * 
 * @param dhSharedSecret - DH output from ratchet step (32 bytes)
 * @param direction - 'outbound' or 'inbound' for topic direction
 * @param salt - Conversation ID bytes for domain separation
 * @returns bytes32 topic as hex string
 */
export function deriveTopicFromDH(
  dhSharedSecret: Uint8Array,
  direction: 'outbound' | 'inbound',
  salt: Uint8Array
): `0x${string}` {
  const info = `verbeth:topic-${direction}:v2`;
  const okm = hkdf(sha256, dhSharedSecret, salt, info, 32);
  return keccak256(okm) as `0x${string}`;
}