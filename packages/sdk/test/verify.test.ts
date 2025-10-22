import { describe, it, expect } from "vitest";
import { Wallet, HDNodeWallet, keccak256, toUtf8Bytes, hexlify } from "ethers";
import nacl from "tweetnacl";

import {
  verifyIdentityProof,
  verifyHandshakeIdentity,
  verifyHandshakeResponseIdentity,
  verifyDerivedDuplexTopics,
} from "../src/verify.js";
import { encryptStructuredPayload, deriveDuplexTopics } from "../src/crypto.js";
import {
  HandshakeResponseContent,
  encodeUnifiedPubKeys,
  parseHandshakeKeys,
} from "../src/payload.js";
import {
  IdentityProof,
  HandshakeLog,
  HandshakeResponseLog,
} from "../src/types.js";
import { deriveIdentityWithUnifiedKeys } from "../src/identity.js";

const mockProvider: any = {
  async request({ method, params }: { method: string; params?: any[] }) {
    if (method === "eth_getCode") {
      const address = params?.[0];
      return address && address.startsWith("0xCc") ? "0x60016000" : "0x";
    }
    if (method === "eth_call") {
      return "0x1";
    }
    if (method === "eth_chainId") {
      return "0x1";
    }
    throw new Error("Unsupported method: " + method);
  },
};

function toBytes(hex: `0x${string}`): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.slice(2), "hex"));
}
function randomTagHex(): `0x${string}` {
  const b = nacl.randomBytes(32);
  return ("0x" + Buffer.from(b).toString("hex")) as `0x${string}`;
}

describe("Verify Identity & Handshake (Unified)", () => {
  describe("Identity Proof Verification", () => {
    it("OK with correct unified keys", async () => {
      const wallet: HDNodeWallet = Wallet.createRandom();
      const { identityProof, identityPubKey, signingPubKey } =
        await deriveIdentityWithUnifiedKeys(wallet, wallet.address);

      const result = await verifyIdentityProof(
        identityProof,
        wallet.address,
        { identityPubKey, signingPubKey },
        mockProvider
      );

      expect(result).toBe(true);
    });

    it("KO with wrong address", async () => {
      const wallet1: HDNodeWallet = Wallet.createRandom();
      const wallet2: HDNodeWallet = Wallet.createRandom();
      const { identityProof, identityPubKey, signingPubKey } =
        await deriveIdentityWithUnifiedKeys(wallet1, wallet1.address);

      const result = await verifyIdentityProof(
        identityProof,
        wallet2.address,
        { identityPubKey, signingPubKey },
        mockProvider
      );

      expect(result).toBe(false);
    });

    it("KO with wrong keys", async () => {
      const wallet: HDNodeWallet = Wallet.createRandom();
      const { identityProof } = await deriveIdentityWithUnifiedKeys(
        wallet,
        wallet.address
      );

      const wrongKeys = {
        identityPubKey: new Uint8Array(32).fill(0xaa),
        signingPubKey: new Uint8Array(32).fill(0xbb),
      };

      const result = await verifyIdentityProof(
        identityProof,
        wallet.address,
        wrongKeys,
        mockProvider
      );

      expect(result).toBe(false);
    });
  });

  describe("Handshake Verification", () => {
    it("EOA flow with unified keys", async () => {
      const wallet: HDNodeWallet = Wallet.createRandom();
      const { identityProof, unifiedPubKeys } =
        await deriveIdentityWithUnifiedKeys(wallet, wallet.address);

      const handshakeEvent: HandshakeLog = {
        recipientHash: keccak256(toUtf8Bytes("contact:0xdead")),
        sender: wallet.address,
        pubKeys: hexlify(unifiedPubKeys),
        ephemeralPubKey: hexlify(nacl.box.keyPair().publicKey),
        plaintextPayload: JSON.stringify({
          plaintextPayload: "Hi VerbEth",
          identityProof,
        }),
      };

      const result = await verifyHandshakeIdentity(
        handshakeEvent,
        mockProvider
      );
      expect(result).toBe(true);
    });

    it("fails with invalid identity proof", async () => {
      const wallet: HDNodeWallet = Wallet.createRandom();
      const { unifiedPubKeys } = await deriveIdentityWithUnifiedKeys(
        wallet,
        wallet.address
      );

      const differentWallet: HDNodeWallet = Wallet.createRandom();
      const invalidMessage = "Invalid message for verification";
      const invalidSignature = await differentWallet.signMessage(
        invalidMessage
      );

      const invalidIdentityProof: IdentityProof = {
        message: invalidMessage,
        signature: invalidSignature,
      };

      const handshakeEvent: HandshakeLog = {
        recipientHash: keccak256(toUtf8Bytes("contact:0xdead")),
        sender: wallet.address,
        pubKeys: hexlify(unifiedPubKeys),
        ephemeralPubKey: hexlify(nacl.box.keyPair().publicKey),
        plaintextPayload: JSON.stringify({
          plaintextPayload: "Hi VerbEth",
          identityProof: invalidIdentityProof,
        }),
      };

      const result = await verifyHandshakeIdentity(
        handshakeEvent,
        mockProvider
      );
      expect(result).toBe(false);
    });
  });

  describe("Handshake Response Verification", () => {
    it("EOA flow with unified keys", async () => {
      const responderWallet: HDNodeWallet = Wallet.createRandom();
      const { identityProof, identityPubKey, unifiedPubKeys } =
        await deriveIdentityWithUnifiedKeys(
          responderWallet,
          responderWallet.address
        );

      const aliceEphemeral = nacl.box.keyPair();
      const responderEphemeral = nacl.box.keyPair();

      const responseContent: HandshakeResponseContent = {
        unifiedPubKeys,
        ephemeralPubKey: responderEphemeral.publicKey,
        note: "pong",
        identityProof,
      };

      const payload = encryptStructuredPayload(
        responseContent,
        aliceEphemeral.publicKey,
        responderEphemeral.secretKey,
        responderEphemeral.publicKey
      );

      const responseEvent: HandshakeResponseLog = {
        inResponseTo: keccak256(toUtf8Bytes("test-handshake")),
        responder: responderWallet.address,
        responderEphemeralR: hexlify(responderEphemeral.publicKey),
        ciphertext: payload,
      };

      const result = await verifyHandshakeResponseIdentity(
        responseEvent,
        identityPubKey,
        aliceEphemeral.secretKey,
        mockProvider
      );

      expect(result).toBe(true);
    });

    it("fails with wrong identity key", async () => {
      const responderWallet: HDNodeWallet = Wallet.createRandom();
      const { identityProof, unifiedPubKeys } =
        await deriveIdentityWithUnifiedKeys(
          responderWallet,
          responderWallet.address
        );

      const aliceEphemeral = nacl.box.keyPair();
      const responderEphemeral = nacl.box.keyPair();

      const responseContent: HandshakeResponseContent = {
        unifiedPubKeys,
        ephemeralPubKey: responderEphemeral.publicKey,
        note: "pong",
        identityProof,
      };

      const payload = encryptStructuredPayload(
        responseContent,
        aliceEphemeral.publicKey,
        responderEphemeral.secretKey,
        responderEphemeral.publicKey
      );

      const responseEvent: HandshakeResponseLog = {
        inResponseTo: keccak256(toUtf8Bytes("test-handshake")),
        responder: responderWallet.address,
        responderEphemeralR: hexlify(responderEphemeral.publicKey),
        ciphertext: payload,
      };

      const wrongIdentityKey = new Uint8Array(32).fill(0xff);

      const result = await verifyHandshakeResponseIdentity(
        responseEvent,
        wrongIdentityKey,
        aliceEphemeral.secretKey,
        mockProvider
      );

      expect(result).toBe(false);
    });
  });

  describe("Key Parsing", () => {
    it("parseHandshakeKeys extracts unified keys correctly", () => {
      const identityPubKey = new Uint8Array(32).fill(1);
      const signingPubKey = new Uint8Array(32).fill(2);
      const unifiedPubKeys = encodeUnifiedPubKeys(
        identityPubKey,
        signingPubKey
      );

      const event = { pubKeys: hexlify(unifiedPubKeys) };
      const parsed = parseHandshakeKeys(event);

      expect(parsed).not.toBeNull();
      expect(parsed!.identityPubKey).toEqual(identityPubKey);
      expect(parsed!.signingPubKey).toEqual(signingPubKey);
    });

    it("parseHandshakeKeys returns null for invalid keys", () => {
      const event = { pubKeys: "0x1234" };
      const parsed = parseHandshakeKeys(event);
      expect(parsed).toBeNull();
    });
  });

  it("verifyDerivedDuplexTopics accepts tag hex and validates checksum from TopicInfo", () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();

    const tag = randomTagHex();
    const salt = toBytes(tag);

    // Bob would embed TopicInfo in HSR 
    const { topicOut, topicIn, checksum } = deriveDuplexTopics(
      bob.secretKey,
      alice.publicKey,
      salt
    );
    const topicInfo = { out: topicOut, in: topicIn, chk: checksum };

    // Alice verifies after decrypting HSR 
    const { topics, ok } = verifyDerivedDuplexTopics({
      myIdentitySecretKey: alice.secretKey,
      theirIdentityPubKey: bob.publicKey,
      tag,
      topicInfo,
    });

    expect(ok).toBe(true);
    expect(topics.topicOut).toBe(topicOut);
    expect(topics.topicIn).toBe(topicIn);
  });

  it("verifyDerivedDuplexTopics works with raw salt (no tag) and throws with neither", () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();

    const salt = toBytes(randomTagHex());

    const { topics } = verifyDerivedDuplexTopics({
      myIdentitySecretKey: alice.secretKey,
      theirIdentityPubKey: bob.publicKey,
      salt,
    });

    expect(topics.topicOut.startsWith("0x")).toBe(true);
    expect(topics.topicIn.startsWith("0x")).toBe(true);

    expect(() =>
      verifyDerivedDuplexTopics({
        myIdentitySecretKey: alice.secretKey,
        theirIdentityPubKey: bob.publicKey,
      } as any)
    ).toThrow();
  });
});
