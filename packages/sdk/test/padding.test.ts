// packages/sdk/test/padding.test.ts

import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';

import {
  padPlaintext,
  unpadPlaintext,
  secureRandomInt,
  PADDING_MARKER,
  FRAMING_SIZE,
  MIN_BUCKET,
  MAX_EXPONENTIAL_BUCKET,
  LINEAR_STEP,
  JITTER_FRACTION,
} from '../src/ratchet/padding.js';

import { ratchetEncrypt, ratchetDecrypt } from '../src/ratchet/index.js';
import { createSessionPair } from './helpers.js';

describe('padPlaintext / unpadPlaintext', () => {
  it('round-trips for various sizes', () => {
    const sizes = [0, 1, 10, 30, 59, 64, 100, 200, 400, 900, 2000, 5000, 16000, 20000];
    for (const size of sizes) {
      const plaintext = nacl.randomBytes(size);
      const padded = padPlaintext(plaintext);
      const recovered = unpadPlaintext(padded);
      expect(recovered).not.toBeNull();
      expect(Buffer.from(recovered!).equals(Buffer.from(plaintext))).toBe(true);
    }
  });

  it('bucket correctness: padded size (minus jitter) is always a valid bucket >= framed plaintext', () => {
    const sizes = [1, 10, 59, 60, 100, 123, 251, 507, 1019, 2043, 4091, 8187, 16379, 20000];
    for (const size of sizes) {
      const plaintext = nacl.randomBytes(size);
      const framedSize = FRAMING_SIZE + size;

      // Run multiple times to account for jitter
      for (let i = 0; i < 10; i++) {
        const padded = padPlaintext(plaintext);
        expect(padded.length).toBeGreaterThanOrEqual(framedSize);

        // Compute expected bucket
        let expectedBucket: number;
        if (framedSize <= MIN_BUCKET) {
          expectedBucket = MIN_BUCKET;
        } else if (framedSize <= MAX_EXPONENTIAL_BUCKET) {
          // Next power of 2
          expectedBucket = 1;
          while (expectedBucket < framedSize) expectedBucket <<= 1;
        } else {
          expectedBucket = Math.ceil(framedSize / LINEAR_STEP) * LINEAR_STEP;
        }

        // Padded size should be in [bucket, bucket + bucket/JITTER_FRACTION)
        expect(padded.length).toBeGreaterThanOrEqual(expectedBucket);
        expect(padded.length).toBeLessThan(expectedBucket + Math.floor(expectedBucket / JITTER_FRACTION));
      }
    }
  });

  it('jitter range: padded size is in [bucket, bucket + bucket/8) over many runs', () => {
    const plaintext = nacl.randomBytes(100); // framed = 105, bucket = 128
    const bucket = 128;
    const jitterMax = Math.floor(bucket / JITTER_FRACTION);
    const observed = new Set<number>();

    for (let i = 0; i < 200; i++) {
      const padded = padPlaintext(plaintext);
      expect(padded.length).toBeGreaterThanOrEqual(bucket);
      expect(padded.length).toBeLessThan(bucket + jitterMax);
      observed.add(padded.length);
    }

    // Should see more than one distinct size (jitter is working)
    expect(observed.size).toBeGreaterThan(1);
  });

  it('minimum bucket: 1-byte message → padded >= 64 bytes', () => {
    const plaintext = new Uint8Array([42]);
    for (let i = 0; i < 20; i++) {
      const padded = padPlaintext(plaintext);
      expect(padded.length).toBeGreaterThanOrEqual(MIN_BUCKET);
    }
  });

  it('strict failure: raw UTF-8 bytes (no marker) returns null', () => {
    const raw = new TextEncoder().encode('Hello, world!');
    // First byte of 'H' is 0x48, not 0x00
    const result = unpadPlaintext(raw);
    expect(result).toBeNull();
  });

  it('strict failure: truncated envelope returns null', () => {
    const truncated = new Uint8Array(3); // less than FRAMING_SIZE
    truncated[0] = PADDING_MARKER;
    const result = unpadPlaintext(truncated);
    expect(result).toBeNull();
  });

  it('strict failure: length field exceeding buffer returns null', () => {
    const buf = new Uint8Array(10);
    buf[0] = PADDING_MARKER;
    // Write length = 100, but buffer is only 10 bytes
    new DataView(buf.buffer).setUint32(1, 100, false);
    const result = unpadPlaintext(buf);
    expect(result).toBeNull();
  });

  it('random fill: padding bytes are not all zeros', () => {
    // Use a small plaintext so there's plenty of padding
    const plaintext = new Uint8Array([1, 2, 3]);
    const padded = padPlaintext(plaintext);
    // Padding starts after framing + plaintext
    const paddingStart = FRAMING_SIZE + plaintext.length;
    const paddingBytes = padded.slice(paddingStart);
    // With 56+ random bytes, all zeros is astronomically unlikely
    expect(paddingBytes.length).toBeGreaterThan(0);
    const allZeros = paddingBytes.every((b) => b === 0);
    expect(allZeros).toBe(false);
  });

  it('large messages: messages > 16384 use linear step bucketing', () => {
    // framed = 5 + 20000 = 20005, should round up to next 4096 multiple = 20480
    const plaintext = nacl.randomBytes(20000);
    const padded = padPlaintext(plaintext);
    const framedSize = FRAMING_SIZE + 20000;
    const expectedBucket = Math.ceil(framedSize / LINEAR_STEP) * LINEAR_STEP;
    expect(padded.length).toBeGreaterThanOrEqual(expectedBucket);
    expect(padded.length).toBeLessThan(expectedBucket + Math.floor(expectedBucket / JITTER_FRACTION));
  });

  it('bucket edge boundaries: test sizes exactly at bucket boundaries', () => {
    // Test at exact bucket boundaries after framing
    // bucket boundaries: 64, 128, 256, 512, 1024, ...
    // framing = 5, so plaintext size to hit boundary exactly is bucket - 5
    const boundaries = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384];
    for (const bucket of boundaries) {
      // Plaintext that makes framedSize == bucket exactly (should fit in this bucket)
      const sizeExact = bucket - FRAMING_SIZE;
      if (sizeExact > 0) {
        const padded = padPlaintext(nacl.randomBytes(sizeExact));
        expect(padded.length).toBeGreaterThanOrEqual(bucket);
      }

      // Plaintext that makes framedSize == bucket - 1 (should fit in this bucket)
      const sizeBelow = bucket - FRAMING_SIZE - 1;
      if (sizeBelow > 0) {
        const padded = padPlaintext(nacl.randomBytes(sizeBelow));
        expect(padded.length).toBeGreaterThanOrEqual(bucket);
      }

      // Plaintext that makes framedSize == bucket + 1 (should go to next bucket)
      const sizeAbove = bucket - FRAMING_SIZE + 1;
      if (sizeAbove > 0 && bucket < MAX_EXPONENTIAL_BUCKET) {
        const nextBucket = bucket * 2;
        const padded = padPlaintext(nacl.randomBytes(sizeAbove));
        expect(padded.length).toBeGreaterThanOrEqual(nextBucket);
      }
    }
  });

  it('buffer wipe: after unpadPlaintext, original buffer is zeroed', () => {
    const plaintext = nacl.randomBytes(50);
    const padded = padPlaintext(plaintext);
    // Copy so we can verify it was non-zero before
    const paddedCopy = new Uint8Array(padded);
    expect(paddedCopy.some((b) => b !== 0)).toBe(true);

    const result = unpadPlaintext(padded);
    expect(result).not.toBeNull();

    // Original padded buffer should now be zeroed
    expect(padded.every((b) => b === 0)).toBe(true);
  });
});

describe('secureRandomInt', () => {
  it('returns 0 for max <= 1', () => {
    expect(secureRandomInt(0)).toBe(0);
    expect(secureRandomInt(1)).toBe(0);
    expect(secureRandomInt(-5)).toBe(0);
  });

  it('produces values in [0, max)', () => {
    for (const max of [2, 3, 5, 7, 10, 16, 100, 255, 1000]) {
      for (let i = 0; i < 50; i++) {
        const val = secureRandomInt(max);
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThan(max);
      }
    }
  });

  it('produces roughly uniform distribution (chi-squared test)', () => {
    const max = 16;
    const samples = 10000;
    const counts = new Array(max).fill(0);

    for (let i = 0; i < samples; i++) {
      counts[secureRandomInt(max)]++;
    }

    const expected = samples / max;
    let chiSquared = 0;
    for (let i = 0; i < max; i++) {
      chiSquared += ((counts[i] - expected) ** 2) / expected;
    }

    // Chi-squared critical value for 15 df at p=0.001 is ~37.7
    // Should easily pass for a uniform distribution
    expect(chiSquared).toBeLessThan(40);
  });
});

describe('padding integration with ratchet', () => {
  it('full ratchet encrypt→decrypt round-trip with padding', () => {
    const { aliceSession, bobSession, aliceSigning } = createSessionPair();

    const message = 'Hello, Bob! This is a padded message.';
    const plaintext = new TextEncoder().encode(message);

    // Alice encrypts
    const encryptResult = ratchetEncrypt(aliceSession, plaintext, aliceSigning.secretKey);

    // Bob decrypts
    const decryptResult = ratchetDecrypt(bobSession, encryptResult.header, encryptResult.ciphertext);

    expect(decryptResult).not.toBeNull();
    expect(new TextDecoder().decode(decryptResult!.plaintext)).toBe(message);
  });

  it('multi-message conversation preserves plaintext through padding', () => {
    let { aliceSession, bobSession, aliceSigning, bobSigning } = createSessionPair();

    const messages = [
      'Short',
      'A medium-length message with some content.',
      'A'.repeat(500),
      '',
      'Final message!',
    ];

    for (const msg of messages) {
      const plaintext = new TextEncoder().encode(msg);

      // Alice → Bob
      const enc = ratchetEncrypt(aliceSession, plaintext, aliceSigning.secretKey);
      aliceSession = enc.session;

      const dec = ratchetDecrypt(bobSession, enc.header, enc.ciphertext);
      expect(dec).not.toBeNull();
      bobSession = dec!.session;
      expect(new TextDecoder().decode(dec!.plaintext)).toBe(msg);

      // Bob → Alice (reply)
      const reply = `Re: ${msg}`;
      const replyPlaintext = new TextEncoder().encode(reply);
      const enc2 = ratchetEncrypt(bobSession, replyPlaintext, bobSigning.secretKey);
      bobSession = enc2.session;

      const dec2 = ratchetDecrypt(aliceSession, enc2.header, enc2.ciphertext);
      expect(dec2).not.toBeNull();
      aliceSession = dec2!.session;
      expect(new TextDecoder().decode(dec2!.plaintext)).toBe(reply);
    }
  });

  it('ciphertext is larger than plaintext + nacl overhead due to padding', () => {
    const { aliceSession, aliceSigning } = createSessionPair();

    const plaintext = new TextEncoder().encode('Hi');
    const enc = ratchetEncrypt(aliceSession, plaintext, aliceSigning.secretKey);

    // Without padding: nonce(24) + plaintext(2) + poly1305(16) = 42
    // With padding: nonce(24) + padded(>=64) + poly1305(16) = >=104
    expect(enc.ciphertext.length).toBeGreaterThanOrEqual(24 + MIN_BUCKET + 16);
  });
});
