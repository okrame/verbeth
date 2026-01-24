// packages/sdk/src/client/HsrTagIndex.ts

/**
 * Index for O(1) HSR (Handshake Response) matching.
 *
 * Caches computed tags for pending contacts to avoid O(n) loops
 * when matching incoming handshake responses.
 */

import { computeTagFromInitiator } from '../crypto.js';

/**
 * Pending contact entry for HSR matching.
 */
export interface PendingContactEntry {
  address: string;
  handshakeEphemeralSecret: Uint8Array;
}

/**
 * Cache entry storing computed tags per R value.
 */
interface CacheEntry {
  address: string;
  secret: Uint8Array;
  tagsByR: Map<string, `0x${string}`>;
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

      if (existing && this.secretsEqual(existing.secret, contact.handshakeEphemeralSecret)) {
        newEntries.set(contact.address, existing);
      } else {
        newEntries.set(contact.address, {
          address: contact.address,
          secret: contact.handshakeEphemeralSecret,
          tagsByR: new Map(),
        });
      }
    }

    // Rebuild tagToAddress map
    this.tagToAddress.clear();
    for (const [address, entry] of newEntries) {
      for (const [, tag] of entry.tagsByR) {
        this.tagToAddress.set(tag, address);
      }
    }

    this.entries = newEntries;
  }

  /**
   * Add a single pending contact without full rebuild.
   *
   * @param contact - Contact to add
   */
  addContact(contact: PendingContactEntry): void {
    const existing = this.entries.get(contact.address);

    if (!existing || !this.secretsEqual(existing.secret, contact.handshakeEphemeralSecret)) {
      this.entries.set(contact.address, {
        address: contact.address,
        secret: contact.handshakeEphemeralSecret,
        tagsByR: new Map(),
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
      // Remove all cached tags for this contact
      for (const [, tag] of entry.tagsByR) {
        this.tagToAddress.delete(tag);
      }
      this.entries.delete(address);
    }
  }


  clear(): void {
    this.entries.clear();
    this.tagToAddress.clear();
  }

  /**
   * Match an HSR by its tag and responder ephemeral public key.
   *
   * First checks the global tag cache for O(1) lookup.
   * If not found, computes tags for all pending contacts for this R
   * and caches them.
   *
   * @param inResponseToTag - The tag from the HSR event
   * @param R - Responder's ephemeral public key (from HSR event)
   * @returns Address of matching contact, or null if no match
   */
  matchByTag(inResponseToTag: `0x${string}`, R: Uint8Array): string | null {
    // Fast path: check global tag cache
    const cachedAddress = this.tagToAddress.get(inResponseToTag);
    if (cachedAddress) {
      return cachedAddress;
    }

    // Slow path: compute tags for all contacts for this R
    const rKey = this.bytesToHex(R);

    for (const [address, entry] of this.entries) {
      // Check if we already computed for this R
      let tag = entry.tagsByR.get(rKey);

      if (!tag) {
        // Compute and cache
        tag = computeTagFromInitiator(entry.secret, R);
        entry.tagsByR.set(rKey, tag);
        this.tagToAddress.set(tag, address);
      }

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

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
