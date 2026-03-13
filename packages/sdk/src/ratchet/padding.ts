// packages/sdk/src/ratchet/padding.ts

/**
 * Ciphertext padding for metadata leak reduction.
 *
 * Bucket-pads plaintext before encryption so on-chain ciphertext lengths
 * reveal only O(log n) bits of plaintext length (power-of-2 buckets with
 * additive jitter). Internal to the ratchet module, not exported publicly.
 */

import nacl from 'tweetnacl';

export const PADDING_MARKER = 0x00;
export const LENGTH_PREFIX_SIZE = 4;
export const FRAMING_SIZE = 1 + LENGTH_PREFIX_SIZE; 
export const MIN_BUCKET = 64;
export const MAX_EXPONENTIAL_BUCKET = 16384;
export const LINEAR_STEP = 4096;
export const JITTER_FRACTION = 8; 

/**
 * Generate a uniform random integer in [0, max) using rejection sampling
 */
export function secureRandomInt(max: number): number {
  if (max <= 0) return 0;
  if (max === 1) return 0;

  // Find smallest power of 2 >= max
  let ceiling = 1;
  while (ceiling < max) {
    ceiling <<= 1;
  }
  const mask = ceiling - 1;

  // Determine how many bytes we need
  const bytesNeeded = Math.ceil(Math.log2(ceiling) / 8) || 1;

  // Rejection sampling
  for (;;) {
    const bytes = nacl.randomBytes(bytesNeeded);
    let value = 0;
    for (let i = 0; i < bytesNeeded; i++) {
      value = (value << 8) | bytes[i];
    }
    value &= mask;
    if (value < max) {
      return value;
    }
  }
}

/**
 * Compute the next power of 2 >= n.
 */
function nextPowerOf2(n: number): number {
  if (n <= 1) return 1;
  let v = n - 1;
  v |= v >> 1;
  v |= v >> 2;
  v |= v >> 4;
  v |= v >> 8;
  v |= v >> 16;
  return v + 1;
}

/**
 * Select the bucket size for a given framed plaintext size.
 */
function selectBucket(framedSize: number): number {
  if (framedSize <= MIN_BUCKET) {
    return MIN_BUCKET;
  }

  if (framedSize <= MAX_EXPONENTIAL_BUCKET) {
    return nextPowerOf2(framedSize);
  }

  // Above MAX_EXPONENTIAL_BUCKET: linear steps of LINEAR_STEP
  return Math.ceil(framedSize / LINEAR_STEP) * LINEAR_STEP;
}

/**
 * Pad plaintext into a fixed-size envelope before encryption.
 *
 * Format: [0x00 marker] [plaintext_length (4 bytes BE)] [plaintext] [random padding]
 */
export function padPlaintext(plaintext: Uint8Array): Uint8Array {
  const framedSize = FRAMING_SIZE + plaintext.length;
  const bucket = selectBucket(framedSize);

  const jitterMax = Math.floor(bucket / JITTER_FRACTION);
  const jitter = jitterMax > 0 ? secureRandomInt(jitterMax) : 0;
  const paddedSize = bucket + jitter;

  const result = new Uint8Array(paddedSize);

  // Marker
  result[0] = PADDING_MARKER;

  // Plaintext length as 4 bytes big-endian
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  view.setUint32(1, plaintext.length, false);
  result.set(plaintext, FRAMING_SIZE);

  // Random padding fill (indistinguishable from ciphertext after encryption)
  const paddingLength = paddedSize - framedSize;
  if (paddingLength > 0) {
    const randomPadding = nacl.randomBytes(paddingLength);
    result.set(randomPadding, framedSize);
  }

  return result;
}

/**
 * Remove padding from a decrypted envelope. Strict validation —
 * returns null on any malformed envelope.
 */
export function unpadPlaintext(decrypted: Uint8Array): Uint8Array | null {
  if (decrypted.length < FRAMING_SIZE) {
    return null;
  }

  if (decrypted[0] !== PADDING_MARKER) {
    return null;
  }

  const view = new DataView(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength);
  const len = view.getUint32(1, false);

  if (FRAMING_SIZE + len > decrypted.length) {
    return null;
  }

  // Extract plaintext before wiping
  const plaintext = decrypted.slice(FRAMING_SIZE, FRAMING_SIZE + len);
  decrypted.fill(0);

  return plaintext;
}
