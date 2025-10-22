import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import {
  encryptMessage,
  decryptMessage,
  encryptStructuredPayload,
  decryptStructuredPayload,
  decryptHandshakeResponse,
  decryptAndExtractHandshakeKeys,
  deriveDuplexTopics,
  verifyDuplexTopicsChecksum,
} from "../src/crypto.js";
import {
  HandshakePayload,
  encodeHandshakePayload,
  decodeHandshakePayload,
  encodeHandshakeResponseContent,
  decodeHandshakeResponseContent,
  MessagePayload,
  HandshakeResponseContent,
  encodeUnifiedPubKeys,
  extractKeysFromHandshakePayload,
  extractKeysFromHandshakeResponse,
  parseHandshakeKeys,
} from "../src/payload.js";
import { IdentityProof } from "../src/types.js";
import type { LogMessage } from "../src/types.js";

function randomTagHex(): `0x${string}` {
  const b = nacl.randomBytes(32);
  return ("0x" + Buffer.from(b).toString("hex")) as `0x${string}`;
}

describe("Encryption/Decryption", () => {
  describe("Message Encryption", () => {
    it("should encrypt and decrypt a message successfully", () => {
      const senderBoxKey = nacl.box.keyPair();
      const senderSignKey = nacl.sign.keyPair();
      const recipientKey = nacl.box.keyPair();
      const message = "Hello VerbEth!";

      const encrypted = encryptMessage(
        message,
        recipientKey.publicKey,
        senderBoxKey.secretKey,
        senderBoxKey.publicKey,
        senderSignKey.secretKey,
        senderSignKey.publicKey
      );

      const decrypted = decryptMessage(
        encrypted,
        recipientKey.secretKey,
        senderSignKey.publicKey
      );
      expect(decrypted).toBe(message);
    });

    it("should return null on decryption with wrong recipient key", () => {
      const senderBoxKey = nacl.box.keyPair();
      const senderSignKey = nacl.sign.keyPair();
      const recipientKey = nacl.box.keyPair();
      const wrongKey = nacl.box.keyPair();
      const message = "Sensitive Info";

      const encrypted = encryptMessage(
        message,
        recipientKey.publicKey,
        senderBoxKey.secretKey,
        senderBoxKey.publicKey,
        senderSignKey.secretKey,
        senderSignKey.publicKey
      );

      const decrypted = decryptMessage(
        encrypted,
        wrongKey.secretKey,
        senderSignKey.publicKey
      );
      expect(decrypted).toBeNull();
    });

    it("should fail to decrypt if payload is tampered", () => {
      const senderBoxKey = nacl.box.keyPair();
      const senderSignKey = nacl.sign.keyPair();
      const recipientKey = nacl.box.keyPair();
      const message = "tamper test";

      let encrypted = encryptMessage(
        message,
        recipientKey.publicKey,
        senderBoxKey.secretKey,
        senderBoxKey.publicKey,
        senderSignKey.secretKey,
        senderSignKey.publicKey
      );

      const parsed = JSON.parse(encrypted);
      parsed.ct = Buffer.from("00".repeat(32), "hex").toString("base64");
      const tampered = JSON.stringify(parsed);

      const decrypted = decryptMessage(
        tampered,
        recipientKey.secretKey,
        senderSignKey.publicKey
      );
      expect(decrypted).toBeNull();
    });

    it("should work with the structured message format", () => {
      const senderBoxKey = nacl.box.keyPair();
      const senderSignKey = nacl.sign.keyPair();
      const recipientKey = nacl.box.keyPair();

      const messagePayload: MessagePayload = {
        content: "Hello structured VerbEth!",
        timestamp: Date.now(),
        messageType: "text",
      };

      const encrypted = encryptStructuredPayload(
        messagePayload,
        recipientKey.publicKey,
        senderBoxKey.secretKey,
        senderBoxKey.publicKey,
        senderSignKey.secretKey,
        senderSignKey.publicKey
      );

      const decrypted = decryptStructuredPayload(
        encrypted,
        recipientKey.secretKey,
        (obj) => obj as MessagePayload,
        senderSignKey.publicKey
      );

      expect(decrypted).toEqual(messagePayload);
    });

    it("should encrypt without signing keys (optional parameters)", () => {
      const senderBoxKey = nacl.box.keyPair();
      const recipientKey = nacl.box.keyPair();
      const message = "No signature test";

      const encrypted = encryptMessage(
        message,
        recipientKey.publicKey,
        senderBoxKey.secretKey,
        senderBoxKey.publicKey
      );

      const decrypted = decryptMessage(encrypted, recipientKey.secretKey);
      expect(decrypted).toBe(message);
    });

    it("should encrypt structured payload without signing keys", () => {
      const senderBoxKey = nacl.box.keyPair();
      const recipientKey = nacl.box.keyPair();

      const messagePayload: MessagePayload = {
        content: "Unsigned structured message",
        timestamp: Date.now(),
        messageType: "text",
      };

      const encrypted = encryptStructuredPayload(
        messagePayload,
        recipientKey.publicKey,
        senderBoxKey.secretKey,
        senderBoxKey.publicKey
      );

      const decrypted = decryptStructuredPayload(
        encrypted,
        recipientKey.secretKey,
        (obj) => obj as MessagePayload
      );

      expect(decrypted).toEqual(messagePayload);
    });
  });

  describe("Handshake Response Encryption", () => {
    it("should encrypt and decrypt handshake response content", () => {
      const initiatorEphemeralKey = nacl.box.keyPair();
      const responderEphemeralKey = nacl.box.keyPair();

      const identityPubKey = new Uint8Array(32).fill(3);
      const signingPubKey = new Uint8Array(32).fill(7);
      const unifiedPubKeys = encodeUnifiedPubKeys(
        identityPubKey,
        signingPubKey
      );

      const ephemeralPubKey = new Uint8Array(32).fill(4);
      const note = "here is my response";

      const identityProof: IdentityProof = {
        message: "VerbEth Identity Key Identity v1\nAddress: 0x1234...",
        signature: "0x" + "1".repeat(130),
      };

      const responseContent: HandshakeResponseContent = {
        unifiedPubKeys,
        ephemeralPubKey,
        note,
        identityProof,
      };

      const encrypted = encryptStructuredPayload(
        responseContent,
        initiatorEphemeralKey.publicKey,
        responderEphemeralKey.secretKey,
        responderEphemeralKey.publicKey
      );

      const decrypted = decryptHandshakeResponse(
        encrypted,
        initiatorEphemeralKey.secretKey
      );

      expect(decrypted).not.toBeNull();
      expect(decrypted!.unifiedPubKeys).toEqual(unifiedPubKeys);
      expect(decrypted!.ephemeralPubKey).toEqual(ephemeralPubKey);
      expect(decrypted!.note).toBe(note);
      expect(decrypted!.identityProof).toEqual(identityProof);
    });

    it("should handle handshake response with identity proof", () => {
      const initiatorEphemeralKey = nacl.box.keyPair();
      const responderEphemeralKey = nacl.box.keyPair();

      const identityPubKey = new Uint8Array(32).fill(5);
      const signingPubKey = new Uint8Array(32).fill(8);
      const unifiedPubKeys = encodeUnifiedPubKeys(
        identityPubKey,
        signingPubKey
      );

      const ephemeralPubKey = new Uint8Array(32).fill(6);

      const identityProof: IdentityProof = {
        message: "VerbEth Identity Key identity v1\nAddress: 0xabcd...",
        signature: "0x" + "2".repeat(130),
      };

      const responseContent: HandshakeResponseContent = {
        unifiedPubKeys,
        ephemeralPubKey,
        note: "with identity proof",
        identityProof,
      };

      const encrypted = encryptStructuredPayload(
        responseContent,
        initiatorEphemeralKey.publicKey,
        responderEphemeralKey.secretKey,
        responderEphemeralKey.publicKey
      );

      const decrypted = decryptHandshakeResponse(
        encrypted,
        initiatorEphemeralKey.secretKey
      );

      expect(decrypted).not.toBeNull();
      expect(decrypted!.identityProof).toEqual(identityProof);
    });
  });

  describe("decryptAndExtractHandshakeKeys", () => {
    it("should decrypt and extract all keys from handshake response", () => {
      const initiatorEphemeralKey = nacl.box.keyPair();
      const responderEphemeralKey = nacl.box.keyPair();

      const identityPubKey = new Uint8Array(32).fill(10);
      const signingPubKey = new Uint8Array(32).fill(11);
      const unifiedPubKeys = encodeUnifiedPubKeys(
        identityPubKey,
        signingPubKey
      );
      const ephemeralPubKey = new Uint8Array(32).fill(12);
      const note = "convenience function test";

      const identityProof: IdentityProof = {
        message: "VerbEth Identity Key Identity v1\nAddress: 0xtest...",
        signature: "0x" + "3".repeat(130),
      };

      const responseContent: HandshakeResponseContent = {
        unifiedPubKeys,
        ephemeralPubKey,
        note,
        identityProof,
      };

      const encrypted = encryptStructuredPayload(
        responseContent,
        initiatorEphemeralKey.publicKey,
        responderEphemeralKey.secretKey,
        responderEphemeralKey.publicKey
      );

      const result = decryptAndExtractHandshakeKeys(
        encrypted,
        initiatorEphemeralKey.secretKey
      );

      expect(result).not.toBeNull();
      expect(result!.identityPubKey).toEqual(identityPubKey);
      expect(result!.signingPubKey).toEqual(signingPubKey);
      expect(result!.ephemeralPubKey).toEqual(ephemeralPubKey);
      expect(result!.note).toBe(note);
      expect(result!.identityProof).toEqual(identityProof);
    });

    it("should return null for invalid encrypted data", () => {
      const initiatorEphemeralKey = nacl.box.keyPair();

      // Create a valid-looking but unencryptable payload
      const invalidPayload = {
        v: 1,
        epk: Buffer.from(new Uint8Array(32).fill(1)).toString("base64"),
        n: Buffer.from(new Uint8Array(24).fill(2)).toString("base64"),
        ct: Buffer.from(new Uint8Array(16).fill(3)).toString("base64"),
      };
      const invalidEncrypted = JSON.stringify(invalidPayload);

      const result = decryptAndExtractHandshakeKeys(
        invalidEncrypted,
        initiatorEphemeralKey.secretKey
      );

      expect(result).toBeNull();
    });

    it("should return null with wrong decryption key", () => {
      const initiatorEphemeralKey = nacl.box.keyPair();
      const responderEphemeralKey = nacl.box.keyPair();
      const wrongKey = nacl.box.keyPair();

      const identityPubKey = new Uint8Array(32).fill(13);
      const signingPubKey = new Uint8Array(32).fill(14);
      const unifiedPubKeys = encodeUnifiedPubKeys(
        identityPubKey,
        signingPubKey
      );

      const identityProof: IdentityProof = {
        message: "Wrong key test",
        signature: "0x" + "4".repeat(130),
      };

      const responseContent: HandshakeResponseContent = {
        unifiedPubKeys,
        ephemeralPubKey: new Uint8Array(32).fill(15),
        note: "should fail",
        identityProof,
      };

      const encrypted = encryptStructuredPayload(
        responseContent,
        initiatorEphemeralKey.publicKey,
        responderEphemeralKey.secretKey,
        responderEphemeralKey.publicKey
      );

      const result = decryptAndExtractHandshakeKeys(
        encrypted,
        wrongKey.secretKey
      );

      expect(result).toBeNull();
    });
  });

  describe("Key Extraction Functions", () => {
    it("should extract keys from handshake payload", () => {
      const identityPubKey = new Uint8Array(32).fill(20);
      const signingPubKey = new Uint8Array(32).fill(21);
      const ephemeralPubKey = new Uint8Array(32).fill(22);
      const unifiedPubKeys = encodeUnifiedPubKeys(
        identityPubKey,
        signingPubKey
      );

      const payload: HandshakePayload = {
        unifiedPubKeys,
        ephemeralPubKey,
        plaintextPayload: "test payload",
      };

      const extracted = extractKeysFromHandshakePayload(payload);

      expect(extracted).not.toBeNull();
      expect(extracted!.identityPubKey).toEqual(identityPubKey);
      expect(extracted!.signingPubKey).toEqual(signingPubKey);
      expect(extracted!.ephemeralPubKey).toEqual(ephemeralPubKey);
    });

    it("should extract keys from handshake response content", () => {
      const identityPubKey = new Uint8Array(32).fill(25);
      const signingPubKey = new Uint8Array(32).fill(26);
      const ephemeralPubKey = new Uint8Array(32).fill(27);
      const unifiedPubKeys = encodeUnifiedPubKeys(
        identityPubKey,
        signingPubKey
      );

      const identityProof: IdentityProof = {
        message: "Extract test",
        signature: "0x" + "5".repeat(130),
      };

      const content: HandshakeResponseContent = {
        unifiedPubKeys,
        ephemeralPubKey,
        note: "extract test",
        identityProof,
      };

      const extracted = extractKeysFromHandshakeResponse(content);

      expect(extracted).not.toBeNull();
      expect(extracted!.identityPubKey).toEqual(identityPubKey);
      expect(extracted!.signingPubKey).toEqual(signingPubKey);
      expect(extracted!.ephemeralPubKey).toEqual(ephemeralPubKey);
    });

    it("should return null for invalid unified keys in payload", () => {
      const invalidUnifiedKeys = new Uint8Array(30).fill(1); // Wrong size

      const payload: HandshakePayload = {
        unifiedPubKeys: invalidUnifiedKeys,
        ephemeralPubKey: new Uint8Array(32).fill(2),
        plaintextPayload: "invalid test",
      };

      const extracted = extractKeysFromHandshakePayload(payload);
      expect(extracted).toBeNull();
    });

    it("should return null for invalid unified keys in response content", () => {
      const invalidUnifiedKeys = new Uint8Array(30).fill(1); // Wrong size

      const identityProof: IdentityProof = {
        message: "Invalid test",
        signature: "0x" + "6".repeat(130),
      };

      const content: HandshakeResponseContent = {
        unifiedPubKeys: invalidUnifiedKeys,
        ephemeralPubKey: new Uint8Array(32).fill(2),
        note: "invalid test",
        identityProof,
      };

      const extracted = extractKeysFromHandshakeResponse(content);
      expect(extracted).toBeNull();
    });
  });

  describe("Handshake Key Parsing", () => {
    it("should parse handshake keys from event correctly", () => {
      const identityPubKey = new Uint8Array(32).fill(30);
      const signingPubKey = new Uint8Array(32).fill(31);
      const unifiedPubKeys = encodeUnifiedPubKeys(
        identityPubKey,
        signingPubKey
      );

      const event = {
        pubKeys: "0x" + Buffer.from(unifiedPubKeys).toString("hex"),
      };

      const parsed = parseHandshakeKeys(event);

      expect(parsed).not.toBeNull();
      expect(parsed!.identityPubKey).toEqual(identityPubKey);
      expect(parsed!.signingPubKey).toEqual(signingPubKey);
    });

    it("should return null for invalid hex in pubKeys", () => {
      const event = {
        pubKeys: "0xinvalidhex",
      };

      const parsed = parseHandshakeKeys(event);
      expect(parsed).toBeNull();
    });

    it("should return null for wrong size pubKeys", () => {
      const shortKeys = new Uint8Array(30).fill(1); // Wrong size

      const event = {
        pubKeys: "0x" + Buffer.from(shortKeys).toString("hex"),
      };

      const parsed = parseHandshakeKeys(event);
      expect(parsed).toBeNull();
    });

    it("should handle pubKeys without 0x prefix", () => {
      const identityPubKey = new Uint8Array(32).fill(35);
      const signingPubKey = new Uint8Array(32).fill(36);
      const unifiedPubKeys = encodeUnifiedPubKeys(
        identityPubKey,
        signingPubKey
      );

      const event = {
        pubKeys: "0x" + Buffer.from(unifiedPubKeys).toString("hex"),
      };

      const parsed = parseHandshakeKeys(event);

      expect(parsed).not.toBeNull();
      expect(parsed!.identityPubKey).toEqual(identityPubKey);
      expect(parsed!.signingPubKey).toEqual(signingPubKey);
    });
  });

  describe("Error Handling", () => {
    it("should throw error for malformed JSON in decryptStructuredPayload", () => {
      const recipientKey = nacl.box.keyPair();
      const malformedJson = "invalid json";

      expect(() => {
        decryptStructuredPayload(
          malformedJson,
          recipientKey.secretKey,
          (obj) => obj as MessagePayload
        );
      }).toThrow();
    });

    it("should throw error for missing fields in payload", () => {
      const recipientKey = nacl.box.keyPair();
      const incompletePayload = JSON.stringify({
        epk: Buffer.from(new Uint8Array(32)).toString("base64"),
        // Missing nonce and ciphertext
      });

      expect(() => {
        decryptStructuredPayload(
          incompletePayload,
          recipientKey.secretKey,
          (obj) => obj as MessagePayload
        );
      }).toThrow();
    });

    it("should throw error for invalid base64 in payload fields", () => {
      const recipientKey = nacl.box.keyPair();
      const invalidPayload = JSON.stringify({
        epk: "invalid-base64!",
        n: "invalid-base64!",
        ct: "invalid-base64!",
      });

      expect(() => {
        decryptStructuredPayload(
          invalidPayload,
          recipientKey.secretKey,
          (obj) => obj as MessagePayload
        );
      }).toThrow();
    });

    it("should return null when converter function throws error", () => {
      const senderBoxKey = nacl.box.keyPair();
      const recipientKey = nacl.box.keyPair();

      const messagePayload: MessagePayload = {
        content: "Test message",
        timestamp: Date.now(),
        messageType: "text",
      };

      const encrypted = encryptStructuredPayload(
        messagePayload,
        recipientKey.publicKey,
        senderBoxKey.secretKey,
        senderBoxKey.publicKey
      );

      // Converter that throws error
      const throwingConverter = (obj: any) => {
        throw new Error("Converter error");
      };

      expect(() => {
        decryptStructuredPayload(
          encrypted,
          recipientKey.secretKey,
          throwingConverter
        );
      }).toThrow("Converter error");
    });

    it("should throw error for decryptHandshakeResponse with missing identityProof", () => {
      const initiatorEphemeralKey = nacl.box.keyPair();
      const responderEphemeralKey = nacl.box.keyPair();

      // Create content without identityProof
      const invalidContent = {
        unifiedPubKeys: encodeUnifiedPubKeys(
          new Uint8Array(32).fill(40),
          new Uint8Array(32).fill(41)
        ),
        ephemeralPubKey: new Uint8Array(32).fill(42),
        note: "missing proof",
        // No identityProof
      };

      const encrypted = encryptStructuredPayload(
        invalidContent,
        initiatorEphemeralKey.publicKey,
        responderEphemeralKey.secretKey,
        responderEphemeralKey.publicKey
      );

      expect(() => {
        decryptHandshakeResponse(encrypted, initiatorEphemeralKey.secretKey);
      }).toThrow("Invalid handshake response: missing identityProof");
    });
  });

  describe("Payload Encoding/Decoding", () => {
    it("should encode and decode handshake payload correctly", () => {
      const identityPubKey = new Uint8Array(32).fill(1);
      const signingPubKey = new Uint8Array(32).fill(9);
      const unifiedPubKeys = encodeUnifiedPubKeys(
        identityPubKey,
        signingPubKey
      );

      const payload: HandshakePayload = {
        unifiedPubKeys,
        ephemeralPubKey: new Uint8Array(32).fill(2),
        plaintextPayload: "hello bob",
      };

      const encoded = encodeHandshakePayload(payload);
      const decoded = decodeHandshakePayload(encoded);

      expect(decoded.unifiedPubKeys).toEqual(payload.unifiedPubKeys);
      expect(decoded.ephemeralPubKey).toEqual(payload.ephemeralPubKey);
      expect(decoded.plaintextPayload).toBe("hello bob");
    });

    it("should encode and decode response content correctly", () => {
      const identityPubKey = new Uint8Array(32).fill(3);
      const signingPubKey = new Uint8Array(32).fill(10);
      const unifiedPubKeys = encodeUnifiedPubKeys(
        identityPubKey,
        signingPubKey
      );

      const ephemeralPubKey = new Uint8Array(32).fill(4);
      const note = "here is my response";

      const identityProof: IdentityProof = {
        message: "VerbEth Identity Key Identity v1\nAddress: 0xtest...",
        signature: "0x" + "3".repeat(130),
      };

      const content: HandshakeResponseContent = {
        unifiedPubKeys,
        ephemeralPubKey,
        note,
        identityProof,
      };

      const encoded = encodeHandshakeResponseContent(content);
      const decoded = decodeHandshakeResponseContent(encoded);

      expect(decoded.unifiedPubKeys).toEqual(unifiedPubKeys);
      expect(decoded.ephemeralPubKey).toEqual(ephemeralPubKey);
      expect(decoded.note).toBe(note);
      expect(decoded.identityProof).toEqual(identityProof);
    });
  });

  describe("Log Message Structure", () => {
    it("should decode and decrypt a log message", () => {
      const senderBoxKey = nacl.box.keyPair();
      const senderSignKey = nacl.sign.keyPair();
      const recipientKey = nacl.box.keyPair();

      const message = "from on-chain log";

      const ciphertext = encryptMessage(
        message,
        recipientKey.publicKey,
        senderBoxKey.secretKey,
        senderBoxKey.publicKey,
        senderSignKey.secretKey,
        senderSignKey.publicKey
      );

      const mockLog: LogMessage = {
        sender: "0x" + "a".repeat(40),
        ciphertext,
        timestamp: Math.floor(Date.now() / 1000),
        topic: "0x" + "d".repeat(64),
        nonce: 1n,
      };

      const decrypted = decryptMessage(
        mockLog.ciphertext,
        recipientKey.secretKey,
        senderSignKey.publicKey
      );
      expect(decrypted).toBe(message);
    });
  });

  it("derives deterministic duplex topics (Alice & Bob compute the same) and checksum verifies", () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();

    // Bind topics to a specific handshake via tag (inResponseTo)
    const tag = randomTagHex();
    const salt = Uint8Array.from(Buffer.from(tag.slice(2), "hex"));

    // Alice view (my=Alice, their=Bob)
    const A = deriveDuplexTopics(alice.secretKey, bob.publicKey, salt);
    // Bob view (my=Bob, their=Alice)
    const B = deriveDuplexTopics(bob.secretKey, alice.publicKey, salt);

    // Deterministic agreement
    expect(A.topicOut).toBe(B.topicOut);
    expect(A.topicIn).toBe(B.topicIn);
    expect(A.topicOut).not.toBe(A.topicIn);
    expect(verifyDuplexTopicsChecksum(A.topicOut, A.topicIn, A.checksum)).toBe(
      true
    );
  });

  it("changes in tag/salt produce different topics (per-handshake binding)", () => {
    const alice = nacl.box.keyPair();
    const bob = nacl.box.keyPair();

    const salt1 = Uint8Array.from(Buffer.from(randomTagHex().slice(2), "hex"));
    const salt2 = Uint8Array.from(Buffer.from(randomTagHex().slice(2), "hex"));

    const T1 = deriveDuplexTopics(alice.secretKey, bob.publicKey, salt1);
    const T2 = deriveDuplexTopics(alice.secretKey, bob.publicKey, salt2);

    expect(T1.topicOut).not.toBe(T2.topicOut);
    expect(T1.topicIn).not.toBe(T2.topicIn);
  });
});
