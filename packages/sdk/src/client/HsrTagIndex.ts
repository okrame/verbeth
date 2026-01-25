// packages/sdk/src/client/HsrTagIndex.ts

/**
 * Index for O(1) HSR (Handshake Response) matching.
 *
 * Caches computed tags for pending contacts to avoid O(n) loops
 * when matching incoming handshake responses.
 */

import { computeHybridTagFromInitiator, decryptHandshakeResponse } from '../crypto.js';
import { kem } from '../pq/kem.js';

export interface PendingContactEntry {
  address: string;
  handshakeEphemeralSecret: Uint8Array;
  kemSecretKey: Uint8Array;
}

interface CacheEntry {
  address: string;
  secret: Uint8Array;
  kemSecretKey: Uint8Array;
}

/**
 * Index for efficient HSR tag matching.
 *
 * When an HSR arrives, we need to find which pending contact it belongs to.
 * This requires computing tag = computeTagFromInitiator(secret, R) for each
 * pending contact until we find a match.
 *
 * This class caches the computed tags per (contact, R) pair, making
 * subsequent lookups O(1) after the first computation.
 *
 * @example
 * ```typescript
 * const hsrIndex = new HsrTagIndex();
 *
 * // When pending contacts change
 * hsrIndex.rebuild(pendingContacts.map(c => ({
 *   address: c.address,
 *   handshakeEphemeralSecret: c.handshakeEphemeralSecret
 * })));
 *
 * // Matching O(1) after first computation for each R
 * const matchedAddress = hsrIndex.matchByTag(inResponseToTag, R);
 * ```
 */
export class HsrTagIndex {
  private entries: Map<string, CacheEntry> = new Map();
  private tagToAddress: Map<string, string> = new Map();

  /**
   * Rebuild the index with a new set of pending contacts.
   *
   * Preserves cached tag computations for contacts that remain.
   * Clears entries for contacts no longer in the list.
   *
   * @param contacts - Current pending contacts
   */
  rebuild(contacts: PendingContactEntry[]): void {
    const newEntries = new Map<string, CacheEntry>();

    for (const contact of contacts) {
      const existing = this.entries.get(contact.address);

      if (existing &&
          this.secretsEqual(existing.secret, contact.handshakeEphemeralSecret) &&
          this.secretsEqual(existing.kemSecretKey, contact.kemSecretKey)) {
        newEntries.set(contact.address, existing);
      } else {
        newEntries.set(contact.address, {
          address: contact.address,
          secret: contact.handshakeEphemeralSecret,
          kemSecretKey: contact.kemSecretKey,
        });
      }
    }

    // Keep tagToAddress cache - it's still valid for already computed tags
    this.entries = newEntries;
  }

  /**
   * Add a single pending contact without full rebuild.
   *
   * @param contact - Contact to add
   */
  addContact(contact: PendingContactEntry): void {
    const existing = this.entries.get(contact.address);

    if (!existing ||
        !this.secretsEqual(existing.secret, contact.handshakeEphemeralSecret) ||
        !this.secretsEqual(existing.kemSecretKey, contact.kemSecretKey)) {
      this.entries.set(contact.address, {
        address: contact.address,
        secret: contact.handshakeEphemeralSecret,
        kemSecretKey: contact.kemSecretKey,
      });
    }
  }

  /**
   * Remove a contact from the index.
   *
   * @param address - Address of contact to remove
   */
  removeContact(address: string): void {
    const entry = this.entries.get(address);
    if (entry) {
      // Remove any cached tags for this address
      for (const [tag, addr] of this.tagToAddress) {
        if (addr === address) {
          this.tagToAddress.delete(tag);
        }
      }
      this.entries.delete(address);
    }
  }


  clear(): void {
    this.entries.clear();
    this.tagToAddress.clear();
  }

  /**
   * Match an HSR by its tag using hybrid (PQ-secure) computation.
   *
   * Decrypts the payload internally to extract kemCiphertext, then
   * decapsulates and computes the hybrid tag for matching.
   *
   * @param inResponseToTag - The tag from the HSR event
   * @param R - Responder's ephemeral public key (from HSR event)
   * @param encryptedPayload - JSON string of the encrypted HSR payload
   * @returns Address of matching contact, or null if no match
   */
  matchByTag(
    inResponseToTag: `0x${string}`,
    R: Uint8Array,
    encryptedPayload: string
  ): string | null {
    // Cache check
    const cachedAddress = this.tagToAddress.get(inResponseToTag);
    if (cachedAddress) {
      return cachedAddress;
    }

    // For each contact: decrypt → extract kemCiphertext → decapsulate → compute hybrid tag
    for (const [address, entry] of this.entries) {
      const decrypted = decryptHandshakeResponse(encryptedPayload, entry.secret);
      if (!decrypted || !decrypted.kemCiphertext) continue;

      const kemSecret = kem.decapsulate(decrypted.kemCiphertext, entry.kemSecretKey);
      const tag = computeHybridTagFromInitiator(entry.secret, R, kemSecret);

      this.tagToAddress.set(tag, address);

      if (tag === inResponseToTag) {
        return address;
      }
    }

    return null;
  }

  /**
   * Get the number of indexed contacts.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Check if a contact is in the index.
   */
  hasContact(address: string): boolean {
    return this.entries.has(address);
  }

  private secretsEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
