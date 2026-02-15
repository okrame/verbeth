// packages/sdk/src/pq/kem.ts

/**
 * ML-KEM-768 Key Encapsulation Mechanism wrapper.
 *
 * Provides post-quantum key encapsulation for hybrid handshakes.
 */

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

export const kem = {
  publicKeyBytes: 1184, // in bytes
  ciphertextBytes: 1088,
  sharedSecretBytes: 32,

  /**
   * Generate a new ML-KEM-768 keypair.
   *
   * @returns Object containing publicKey and secretKey
   */
  generateKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
    return ml_kem768.keygen();
  },

  /**
   * Encapsulate a shared secret using the recipient's public key.
   *
   * @param publicKey - Recipient's ML-KEM-768 public key
   * @returns Object containing ciphertext and sharedSecret
   */
  encapsulate(publicKey: Uint8Array): { ciphertext: Uint8Array; sharedSecret: Uint8Array } {
    const result = ml_kem768.encapsulate(publicKey);
    return { ciphertext: result.cipherText, sharedSecret: result.sharedSecret };
  },

  /**
   * Decapsulate a ciphertext using the secret key to recover the shared secret.
   *
   * @param ciphertext - KEM ciphertext
   * @param secretKey - Recipient's ML-KEM-768 secret key
   * @returns Shared secret
   */
  decapsulate(ciphertext: Uint8Array, secretKey: Uint8Array): Uint8Array {
    return ml_kem768.decapsulate(ciphertext, secretKey);
  }
};
