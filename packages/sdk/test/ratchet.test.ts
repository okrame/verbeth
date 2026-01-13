// packages/sdk/test/ratchet.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import nacl from "tweetnacl";
import {
  initSessionAsResponder,
  initSessionAsInitiator,
  computeConversationId,
  ratchetEncrypt,
  ratchetDecrypt,
  pruneExpiredSkippedKeys,
  packageRatchetPayload,
  parseRatchetPayload,
  isRatchetPayload,
  hexToBytes,
  bytesToHex,
  verifyMessageSignature,
  generateDHKeyPair,
  RatchetSession,
} from "../src/ratchet/index.js";


function createTestTopics(): { topicOut: `0x${string}`; topicIn: `0x${string}` } {
  const randomBytes = nacl.randomBytes(32);
  const topicOut = bytesToHex(randomBytes) as `0x${string}`;
  const topicIn = bytesToHex(nacl.randomBytes(32)) as `0x${string}`;
  return { topicOut, topicIn };
}

function createSigningKeyPair() {
  return nacl.sign.keyPair();
}

// =============================================================================
// Tests
// =============================================================================

describe("Double Ratchet", () => {
  describe("Session Initialization", () => {
    it("should create matching sessions for responder and initiator", () => {
      const aliceEphemeral = generateDHKeyPair();
      const bobEphemeral = generateDHKeyPair();
      const topics = createTestTopics();

      // Bob (responder) creates session first
      const bobSession = initSessionAsResponder({
        myAddress: "0xBob",
        contactAddress: "0xAlice",
        myResponderEphemeralSecret: bobEphemeral.secretKey,
        myResponderEphemeralPublic: bobEphemeral.publicKey,
        theirHandshakeEphemeralPubKey: aliceEphemeral.publicKey,
        topicOutbound: topics.topicIn, // Bob's outbound = Alice's inbound
        topicInbound: topics.topicOut, // Bob's inbound = Alice's outbound
      });

      // Alice (initiator) creates session after receiving response
      const aliceSession = initSessionAsInitiator({
        myAddress: "0xAlice",
        contactAddress: "0xBob",
        myHandshakeEphemeralSecret: aliceEphemeral.secretKey,
        theirResponderEphemeralPubKey: bobEphemeral.publicKey,
        topicOutbound: topics.topicOut,
        topicInbound: topics.topicIn,
      });

      // Verify conversation IDs match
      expect(bobSession.conversationId).toBe(aliceSession.conversationId);

      // Verify both have sending chain keys (can send immediately)
      expect(bobSession.sendingChainKey).not.toBeNull();
      expect(aliceSession.sendingChainKey).not.toBeNull();

      // Verify Alice has receiving chain (for Bob's messages)
      expect(aliceSession.receivingChainKey).not.toBeNull();
    });

    it("should compute deterministic conversation ID", () => {
      const topicA = "0xaaaa" as const;
      const topicB = "0xbbbb" as const;

      const id1 = computeConversationId(topicA, topicB);
      const id2 = computeConversationId(topicB, topicA);

      expect(id1).toBe(id2); // Order shouldn't matter
    });
  });

  describe("Encrypt/Decrypt Round-Trip", () => {
    let aliceSession: RatchetSession;
    let bobSession: RatchetSession;
    let aliceSigning: nacl.SignKeyPair;
    let bobSigning: nacl.SignKeyPair;

    beforeEach(() => {
      // Setup sessions
      const aliceEphemeral = generateDHKeyPair();
      const bobEphemeral = generateDHKeyPair();
      const topics = createTestTopics();

      bobSession = initSessionAsResponder({
        myAddress: "0xBob",
        contactAddress: "0xAlice",
        myResponderEphemeralSecret: bobEphemeral.secretKey,
        myResponderEphemeralPublic: bobEphemeral.publicKey,
        theirHandshakeEphemeralPubKey: aliceEphemeral.publicKey,
        topicOutbound: topics.topicIn,
        topicInbound: topics.topicOut,
      });

      aliceSession = initSessionAsInitiator({
        myAddress: "0xAlice",
        contactAddress: "0xBob",
        myHandshakeEphemeralSecret: aliceEphemeral.secretKey,
        theirResponderEphemeralPubKey: bobEphemeral.publicKey,
        topicOutbound: topics.topicOut,
        topicInbound: topics.topicIn,
      });

      aliceSigning = createSigningKeyPair();
      bobSigning = createSigningKeyPair();
    });

    it("should encrypt and decrypt a message (Bob to Alice)", () => {
      const plaintext = new TextEncoder().encode("Hello Alice!");

      // Bob encrypts
      const { session: bobAfter, header, ciphertext, signature } = ratchetEncrypt(
        bobSession,
        plaintext,
        bobSigning.secretKey
      );

      // Verify signature
      const sigValid = verifyMessageSignature(
        signature,
        header,
        ciphertext,
        bobSigning.publicKey
      );
      expect(sigValid).toBe(true);

      // Alice decrypts
      const result = ratchetDecrypt(aliceSession, header, ciphertext);

      expect(result).not.toBeNull();
      expect(new TextDecoder().decode(result!.plaintext)).toBe("Hello Alice!");

      // Verify session states advanced
      expect(bobAfter.sendingMsgNumber).toBe(1);
      expect(result!.session.receivingMsgNumber).toBe(1);
    });

    it("should encrypt and decrypt a message (Alice to Bob)", () => {
      const plaintext = new TextEncoder().encode("Hello Bob!");

      // Alice encrypts
      const { session: aliceAfter, header, ciphertext, signature } = ratchetEncrypt(
        aliceSession,
        plaintext,
        aliceSigning.secretKey
      );

      // Verify signature
      const sigValid = verifyMessageSignature(
        signature,
        header,
        ciphertext,
        aliceSigning.publicKey
      );
      expect(sigValid).toBe(true);

      // Bob decrypts (triggers DH ratchet since Alice has new DH key)
      const result = ratchetDecrypt(bobSession, header, ciphertext);

      expect(result).not.toBeNull();
      expect(new TextDecoder().decode(result!.plaintext)).toBe("Hello Bob!");
    });

    it("should handle alternating messages (ping-pong)", () => {
      // Bob -> Alice
      const msg1 = new TextEncoder().encode("Message 1 from Bob");
      const enc1 = ratchetEncrypt(bobSession, msg1, bobSigning.secretKey);
      const dec1 = ratchetDecrypt(aliceSession, enc1.header, enc1.ciphertext);
      expect(dec1).not.toBeNull();

      // Update sessions
      bobSession = enc1.session;
      aliceSession = dec1!.session;

      // Alice -> Bob
      const msg2 = new TextEncoder().encode("Message 2 from Alice");
      const enc2 = ratchetEncrypt(aliceSession, msg2, aliceSigning.secretKey);
      const dec2 = ratchetDecrypt(bobSession, enc2.header, enc2.ciphertext);
      expect(dec2).not.toBeNull();

      // Update sessions
      aliceSession = enc2.session;
      bobSession = dec2!.session;

      // Bob -> Alice again
      const msg3 = new TextEncoder().encode("Message 3 from Bob");
      const enc3 = ratchetEncrypt(bobSession, msg3, bobSigning.secretKey);
      const dec3 = ratchetDecrypt(aliceSession, enc3.header, enc3.ciphertext);
      expect(dec3).not.toBeNull();

      expect(new TextDecoder().decode(dec3!.plaintext)).toBe("Message 3 from Bob");
    });

    it("should handle multiple sequential messages from same sender", () => {
      const messages = ["First", "Second", "Third"];
      let currentBobSession = bobSession;
      let currentAliceSession = aliceSession;

      // Bob sends multiple messages
      for (const msg of messages) {
        const plaintext = new TextEncoder().encode(msg);
        const encrypted = ratchetEncrypt(currentBobSession, plaintext, bobSigning.secretKey);
        currentBobSession = encrypted.session;

        const decrypted = ratchetDecrypt(currentAliceSession, encrypted.header, encrypted.ciphertext);
        expect(decrypted).not.toBeNull();
        expect(new TextDecoder().decode(decrypted!.plaintext)).toBe(msg);
        currentAliceSession = decrypted!.session;
      }

      expect(currentBobSession.sendingMsgNumber).toBe(3);
      expect(currentAliceSession.receivingMsgNumber).toBe(3);
    });
  });

  describe("Binary Codec", () => {
    it("should encode and decode payload correctly", () => {
      const signature = nacl.randomBytes(64);
      const header = {
        dh: nacl.randomBytes(32),
        pn: 42,
        n: 123,
      };
      const ciphertext = nacl.randomBytes(100);

      const payload = packageRatchetPayload(signature, header, ciphertext);
      const parsed = parseRatchetPayload(payload);

      expect(parsed).not.toBeNull();
      expect(parsed!.version).toBe(0x01);
      expect(Buffer.from(parsed!.signature)).toEqual(Buffer.from(signature));
      expect(Buffer.from(parsed!.header.dh)).toEqual(Buffer.from(header.dh));
      expect(parsed!.header.pn).toBe(42);
      expect(parsed!.header.n).toBe(123);
      expect(Buffer.from(parsed!.ciphertext)).toEqual(Buffer.from(ciphertext));
    });

    it("should detect ratchet payload format", () => {
      const validPayload = new Uint8Array(110);
      validPayload[0] = 0x01; // Version byte

      expect(isRatchetPayload(validPayload)).toBe(true);

      const jsonPayload = new TextEncoder().encode('{"v":1}');
      expect(isRatchetPayload(jsonPayload)).toBe(false);
    });

    it("should reject truncated payloads", () => {
      const truncated = new Uint8Array(50); 
      truncated[0] = 0x01;

      expect(parseRatchetPayload(truncated)).toBeNull();
    });
  });

  describe("Authentication", () => {
    it("should reject invalid signatures", () => {
      const header = {
        dh: nacl.randomBytes(32),
        pn: 0,
        n: 0,
      };
      const ciphertext = nacl.randomBytes(50);
      const wrongSignature = nacl.randomBytes(64);
      const signingKey = createSigningKeyPair();

      const result = verifyMessageSignature(
        wrongSignature,
        header,
        ciphertext,
        signingKey.publicKey
      );

      expect(result).toBe(false);
    });

    it("should reject signatures from wrong key", () => {
      const header = {
        dh: nacl.randomBytes(32),
        pn: 0,
        n: 0,
      };
      const ciphertext = nacl.randomBytes(50);
      const realSigner = createSigningKeyPair();
      const wrongSigner = createSigningKeyPair();

      // Sign with real key
      const headerBytes = new Uint8Array(40);
      headerBytes.set(header.dh, 0);
      new DataView(headerBytes.buffer).setUint32(32, header.pn, false);
      new DataView(headerBytes.buffer).setUint32(36, header.n, false);

      const dataToSign = new Uint8Array(headerBytes.length + ciphertext.length);
      dataToSign.set(headerBytes, 0);
      dataToSign.set(ciphertext, headerBytes.length);

      const signature = nacl.sign.detached(dataToSign, realSigner.secretKey);

      // Verify with wrong key
      const result = verifyMessageSignature(
        signature,
        header,
        ciphertext,
        wrongSigner.publicKey // Wrong key!
      );

      expect(result).toBe(false);
    });
  });

  describe("Skip Key Handling", () => {
    it("should handle out-of-order messages", () => {
      // Setup sessions
      const aliceEphemeral = generateDHKeyPair();
      const bobEphemeral = generateDHKeyPair();
      const topics = createTestTopics();

      let bobSession = initSessionAsResponder({
        myAddress: "0xBob",
        contactAddress: "0xAlice",
        myResponderEphemeralSecret: bobEphemeral.secretKey,
        myResponderEphemeralPublic: bobEphemeral.publicKey,
        theirHandshakeEphemeralPubKey: aliceEphemeral.publicKey,
        topicOutbound: topics.topicIn,
        topicInbound: topics.topicOut,
      });

      let aliceSession = initSessionAsInitiator({
        myAddress: "0xAlice",
        contactAddress: "0xBob",
        myHandshakeEphemeralSecret: aliceEphemeral.secretKey,
        theirResponderEphemeralPubKey: bobEphemeral.publicKey,
        topicOutbound: topics.topicOut,
        topicInbound: topics.topicIn,
      });

      const bobSigning = createSigningKeyPair();

      // Bob sends 3 messages
      const enc1 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 1"), bobSigning.secretKey);
      bobSession = enc1.session;

      const enc2 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 2"), bobSigning.secretKey);
      bobSession = enc2.session;

      const enc3 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 3"), bobSigning.secretKey);
      bobSession = enc3.session;

      // Alice receives msg 3 first (out of order)
      const dec3 = ratchetDecrypt(aliceSession, enc3.header, enc3.ciphertext);
      expect(dec3).not.toBeNull();
      expect(new TextDecoder().decode(dec3!.plaintext)).toBe("Msg 3");
      aliceSession = dec3!.session;

      // Verify skip keys were created for msg 1 and 2
      expect(aliceSession.skippedKeys.length).toBe(2);

      // Alice receives msg 1 (using skip key)
      const dec1 = ratchetDecrypt(aliceSession, enc1.header, enc1.ciphertext);
      expect(dec1).not.toBeNull();
      expect(new TextDecoder().decode(dec1!.plaintext)).toBe("Msg 1");
      aliceSession = dec1!.session;

      // One skip key used
      expect(aliceSession.skippedKeys.length).toBe(1);

      // Alice receives msg 2 (using skip key)
      const dec2 = ratchetDecrypt(aliceSession, enc2.header, enc2.ciphertext);
      expect(dec2).not.toBeNull();
      expect(new TextDecoder().decode(dec2!.plaintext)).toBe("Msg 2");
      aliceSession = dec2!.session;

      // All skip keys used
      expect(aliceSession.skippedKeys.length).toBe(0);
    });
  });

  describe("Utility Functions", () => {
    it("should prune expired skipped keys", () => {
      const session: RatchetSession = {
        conversationId: "test",
        topicOutbound: "0xabc" as `0x${string}`,
        topicInbound: "0xdef" as `0x${string}`,
        myAddress: "0x1",
        contactAddress: "0x2",
        rootKey: new Uint8Array(32),
        dhMySecretKey: new Uint8Array(32),
        dhMyPublicKey: new Uint8Array(32),
        dhTheirPublicKey: new Uint8Array(32),
        sendingChainKey: new Uint8Array(32),
        sendingMsgNumber: 0,
        receivingChainKey: new Uint8Array(32),
        receivingMsgNumber: 0,
        previousChainLength: 0,
        skippedKeys: [
          { dhPubKeyHex: "0x1", msgNumber: 0, messageKey: new Uint8Array(32), createdAt: Date.now() - 1000 }, // Fresh
          { dhPubKeyHex: "0x1", msgNumber: 1, messageKey: new Uint8Array(32), createdAt: Date.now() - 100000000 }, // Expired
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        epoch: 0,
      };

      const pruned = pruneExpiredSkippedKeys(session, 50000); 

      expect(pruned.skippedKeys.length).toBe(1);
      expect(pruned.skippedKeys[0].msgNumber).toBe(0); 
    });

    it("should convert hex to bytes and back", () => {
      const original = nacl.randomBytes(32);
      const hex = bytesToHex(original);
      const restored = hexToBytes(hex);

      expect(Buffer.from(restored)).toEqual(Buffer.from(original));
    });
  });
});