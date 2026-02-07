// packages/sdk/test/codec.test.ts

import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import {
  packageRatchetPayload,
  parseRatchetPayload,
  isRatchetPayload,
  isRatchetPayloadHex,
  hexToBytes,
  bytesToHex,
  RATCHET_VERSION_V1,
} from "../src/ratchet/index.js";
import type { MessageHeader } from "../src/ratchet/types.js";

function makeHeader(overrides?: Partial<MessageHeader>): MessageHeader {
  return {
    dh: nacl.randomBytes(32),
    pn: 5,
    n: 42,
    ...overrides,
  };
}

describe("ratchet/codec", () => {
  describe("packageRatchetPayload + parseRatchetPayload round-trip", () => {
    it("encodes and decodes correctly", () => {
      const sig = nacl.randomBytes(64);
      const header = makeHeader();
      const ciphertext = nacl.randomBytes(200);

      const payload = packageRatchetPayload(sig, header, ciphertext);
      const parsed = parseRatchetPayload(payload);

      expect(parsed).not.toBeNull();
      expect(parsed!.version).toBe(RATCHET_VERSION_V1);
      expect(parsed!.signature).toEqual(sig);
      expect(parsed!.header.dh).toEqual(header.dh);
      expect(parsed!.header.pn).toBe(header.pn);
      expect(parsed!.header.n).toBe(header.n);
      expect(parsed!.ciphertext).toEqual(ciphertext);
    });
  });

  describe("parseRatchetPayload edge cases", () => {
    it("returns null for payload too short", () => {
      const tooShort = new Uint8Array(50);
      expect(parseRatchetPayload(tooShort)).toBeNull();
    });

    it("returns null for wrong version byte", () => {
      const sig = nacl.randomBytes(64);
      const header = makeHeader();
      const ciphertext = nacl.randomBytes(16);

      const payload = packageRatchetPayload(sig, header, ciphertext);
      payload[0] = 0xff; // corrupt version

      expect(parseRatchetPayload(payload)).toBeNull();
    });
  });

  describe("packageRatchetPayload validation", () => {
    it("throws for wrong signature length", () => {
      const badSig = new Uint8Array(32); // should be 64
      const header = makeHeader();
      const ct = new Uint8Array(10);

      expect(() => packageRatchetPayload(badSig, header, ct)).toThrow(
        /signature length/i
      );
    });

    it("throws for wrong DH key length", () => {
      const sig = new Uint8Array(64);
      const header = makeHeader({ dh: new Uint8Array(16) }); // should be 32
      const ct = new Uint8Array(10);

      expect(() => packageRatchetPayload(sig, header, ct)).toThrow(
        /DH key length/i
      );
    });
  });

  describe("isRatchetPayload", () => {
    it("returns true for valid ratchet payload", () => {
      const sig = nacl.randomBytes(64);
      const header = makeHeader();
      const payload = packageRatchetPayload(sig, header, nacl.randomBytes(10));

      expect(isRatchetPayload(payload)).toBe(true);
    });

    it("returns false for too-short payload", () => {
      expect(isRatchetPayload(new Uint8Array(10))).toBe(false);
    });

    it("returns false for wrong version", () => {
      const payload = new Uint8Array(105);
      payload[0] = 0xff;
      expect(isRatchetPayload(payload)).toBe(false);
    });
  });

  describe("isRatchetPayloadHex", () => {
    it("returns true with 0x prefix", () => {
      const sig = nacl.randomBytes(64);
      const header = makeHeader();
      const payload = packageRatchetPayload(sig, header, nacl.randomBytes(10));
      const hex = bytesToHex(payload);

      expect(isRatchetPayloadHex(hex)).toBe(true);
    });

    it("returns true without prefix", () => {
      const sig = nacl.randomBytes(64);
      const header = makeHeader();
      const payload = packageRatchetPayload(sig, header, nacl.randomBytes(10));
      const hex = bytesToHex(payload, false);

      expect(isRatchetPayloadHex(hex)).toBe(true);
    });

    it("returns false for too-short hex", () => {
      expect(isRatchetPayloadHex("0x01")).toBe(false);
    });
  });

  describe("hexToBytes / bytesToHex round-trip", () => {
    it("round-trips with 0x prefix", () => {
      const original = nacl.randomBytes(48);
      const hex = bytesToHex(original);
      const back = hexToBytes(hex);
      expect(back).toEqual(original);
    });

    it("round-trips without prefix", () => {
      const original = nacl.randomBytes(48);
      const hex = bytesToHex(original, false);
      expect(hex.startsWith("0x")).toBe(false);
      const back = hexToBytes(hex);
      expect(back).toEqual(original);
    });

    it("handles empty array", () => {
      const empty = new Uint8Array(0);
      const hex = bytesToHex(empty);
      expect(hex).toBe("0x");
      expect(hexToBytes(hex)).toEqual(empty);
    });
  });
});
