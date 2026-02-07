// packages/sdk/test/identity.test.ts

import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import {
  deriveIdentityKeys,
  createBindingProof,
  deriveIdentityKeyPairWithProof,
} from "../src/identity.js";
import { parseBindingMessage } from "../src/utils.js";

// Deterministic "signer" - a Wallet with a fixed private key.
// signMessage is real ECDSA so we can test the full derivation flow.
const PRIV_KEY = "0x" + "aa".repeat(32);
const signer = new Wallet(PRIV_KEY);
const address = signer.address;

const PRIV_KEY_2 = "0x" + "bb".repeat(32);
const signer2 = new Wallet(PRIV_KEY_2);
const address2 = signer2.address;

describe("identity", () => {
  describe("deriveIdentityKeys", () => {
    it("is deterministic: same signer + address → same keys", async () => {
      const a = await deriveIdentityKeys(signer, address);
      const b = await deriveIdentityKeys(signer, address);

      expect(a.keyPair.publicKey).toEqual(b.keyPair.publicKey);
      expect(a.keyPair.signingPublicKey).toEqual(b.keyPair.signingPublicKey);
      expect(a.sessionPrivateKey).toBe(b.sessionPrivateKey);
      expect(a.sessionAddress).toBe(b.sessionAddress);
    });

    it("produces keys of correct sizes", async () => {
      const d = await deriveIdentityKeys(signer, address);

      // X25519
      expect(d.keyPair.publicKey).toHaveLength(32);
      expect(d.keyPair.secretKey).toHaveLength(32);
      // Ed25519
      expect(d.keyPair.signingPublicKey).toHaveLength(32);
      expect(d.keyPair.signingSecretKey).toHaveLength(64);
    });

    it("different address produces different keys", async () => {
      const a = await deriveIdentityKeys(signer, address);
      const b = await deriveIdentityKeys(signer2, address2);

      expect(a.keyPair.publicKey).not.toEqual(b.keyPair.publicKey);
      expect(a.keyPair.signingPublicKey).not.toEqual(b.keyPair.signingPublicKey);
    });
  });

  describe("createBindingProof", () => {
    it("produces a message with the correct header and keys", async () => {
      const derived = await deriveIdentityKeys(signer, address);
      const safeAddr = "0x" + "cc".repeat(20);
      const proof = await createBindingProof(signer, address, derived, safeAddr);

      const parsed = parseBindingMessage(proof.message);

      expect(parsed.header).toBe("VerbEth Key Binding v1");
      expect(parsed.pkX25519).toBe(derived.pkX25519Hex);
      expect(parsed.pkEd25519).toBe(derived.pkEd25519Hex);
      expect(parsed.executorSafeAddress?.toLowerCase()).toBe(safeAddr.toLowerCase());
    });

    it("includes chainId and rpId when context is provided", async () => {
      const derived = await deriveIdentityKeys(signer, address);
      const proof = await createBindingProof(signer, address, derived, address, {
        chainId: 8453,
        rpId: "example.com",
      });

      const parsed = parseBindingMessage(proof.message);
      expect(parsed.chainId).toBe(8453);
      expect(parsed.rpId).toBe("example.com");
    });
  });

  describe("deriveIdentityKeyPairWithProof", () => {
    it("proof.message contains the derived keys", async () => {
      const result = await deriveIdentityKeyPairWithProof(signer, address, address);

      const parsed = parseBindingMessage(result.identityProof.message);

      expect(parsed.pkX25519).toBe(result.pkX25519Hex);
      expect(parsed.pkEd25519).toBe(result.pkEd25519Hex);
    });

    it("has a non-empty signature", async () => {
      const result = await deriveIdentityKeyPairWithProof(signer, address);

      expect(result.identityProof.signature).toBeTruthy();
      expect(result.identityProof.signature.startsWith("0x")).toBe(true);
      // 65 bytes → 130 hex chars + 0x prefix
      expect(result.identityProof.signature.length).toBe(132);
    });
  });
});
