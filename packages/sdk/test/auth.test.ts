// packages/sdk/test/auth.test.ts

import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import {
  signMessage,
  verifyMessageSignature,
  isValidPayloadFormat,
} from "../src/ratchet/auth.js";
import type { MessageHeader } from "../src/ratchet/types.js";
import { createSigningKeyPair } from "./helpers.js";

function makeHeader(overrides?: Partial<MessageHeader>): MessageHeader {
  return {
    dh: nacl.randomBytes(32),
    pn: 0,
    n: 42,
    ...overrides,
  };
}

describe("ratchet/auth", () => {
  describe("signMessage + verifyMessageSignature round-trip", () => {
    it("verifies a correctly signed message", () => {
      const kp = createSigningKeyPair();
      const header = makeHeader();
      const ciphertext = nacl.randomBytes(128);

      const sig = signMessage(header, ciphertext, kp.secretKey);
      expect(sig).toHaveLength(64);

      const ok = verifyMessageSignature(sig, header, ciphertext, kp.publicKey);
      expect(ok).toBe(true);
    });

    it("rejects when ciphertext is tampered", () => {
      const kp = createSigningKeyPair();
      const header = makeHeader();
      const ciphertext = nacl.randomBytes(128);

      const sig = signMessage(header, ciphertext, kp.secretKey);

      const tampered = new Uint8Array(ciphertext);
      tampered[0] ^= 0xff;

      expect(verifyMessageSignature(sig, header, tampered, kp.publicKey)).toBe(false);
    });

    it("rejects when header.n is tampered", () => {
      const kp = createSigningKeyPair();
      const header = makeHeader({ n: 10 });
      const ciphertext = nacl.randomBytes(64);

      const sig = signMessage(header, ciphertext, kp.secretKey);

      const badHeader = { ...header, n: 11 };
      expect(verifyMessageSignature(sig, badHeader, ciphertext, kp.publicKey)).toBe(false);
    });

    it("rejects with wrong public key", () => {
      const kp = createSigningKeyPair();
      const other = createSigningKeyPair();
      const header = makeHeader();
      const ciphertext = nacl.randomBytes(64);

      const sig = signMessage(header, ciphertext, kp.secretKey);
      expect(verifyMessageSignature(sig, header, ciphertext, other.publicKey)).toBe(false);
    });
  });

  describe("isValidPayloadFormat", () => {
    it("returns true for valid format", () => {
      const sig = new Uint8Array(64);
      const header = makeHeader();
      expect(isValidPayloadFormat(sig, header)).toBe(true);
    });

    it("rejects short signature", () => {
      const sig = new Uint8Array(32); // too short
      const header = makeHeader();
      expect(isValidPayloadFormat(sig, header)).toBe(false);
    });

    it("rejects short dh key", () => {
      const sig = new Uint8Array(64);
      const header = makeHeader({ dh: new Uint8Array(16) });
      expect(isValidPayloadFormat(sig, header)).toBe(false);
    });

    it("rejects negative n", () => {
      const sig = new Uint8Array(64);
      const header = makeHeader({ n: -1 });
      expect(isValidPayloadFormat(sig, header)).toBe(false);
    });

    it("rejects non-integer pn", () => {
      const sig = new Uint8Array(64);
      const header = makeHeader({ pn: 1.5 });
      expect(isValidPayloadFormat(sig, header)).toBe(false);
    });
  });
});
