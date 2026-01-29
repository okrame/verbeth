// packages/sdk/src/client/hsrMatcher.ts

import { computeHybridTagFromInitiator, decryptHandshakeResponse } from '../crypto.js';
import { kem } from '../pq/kem.js';

export interface PendingContactEntry {
  address: string;
  handshakeEphemeralSecret: Uint8Array;
  kemSecretKey: Uint8Array;
}

/**
 * Match an HSR event to a pending contact by computing hybrid tags.
 *
 * For each pending contact, attempts to decrypt the HSR payload and compute
 * the expected tag. Returns the address of the first matching contact.
 *
 * Complexity: O(N) where N = number of pending contacts.
 * Per contact: NaCl decrypt + ML-KEM decapsulate + HKDF tag computation.
 *
 * @param pendingContacts - Contacts with pending handshakes
 * @param inResponseToTag - The tag from the HSR event (topics[1])
 * @param R - Responder's ephemeral public key (from HSR event data)
 * @param encryptedPayload - JSON string of the encrypted HSR payload
 * @returns Address of matching contact, or null if no match
 */
export function matchHsrToContact(
  pendingContacts: PendingContactEntry[],
  inResponseToTag: `0x${string}`,
  R: Uint8Array,
  encryptedPayload: string
): string | null {
  for (const contact of pendingContacts) {
    const decrypted = decryptHandshakeResponse(encryptedPayload, contact.handshakeEphemeralSecret);
    if (!decrypted?.kemCiphertext) continue;

    const kemSecret = kem.decapsulate(decrypted.kemCiphertext, contact.kemSecretKey);
    const tag = computeHybridTagFromInitiator(contact.handshakeEphemeralSecret, R, kemSecret);

    if (tag === inResponseToTag) {
      return contact.address;
    }
  }
  return null;
}
