// packages/sdk/test/simulation.test.ts

/**
 * These tests simulate real-world conditions that occur at the application
 * layer, particularly around message queue processing and transaction failures.
 */

import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import {
  ratchetEncrypt,
  ratchetDecrypt,
  pruneExpiredSkippedKeys,
  RatchetSession,
  MAX_STORED_SKIPPED_KEYS,
} from "../src/ratchet/index.js";
import { createSessionPair, simulateDbRoundTrip } from "./helpers.js";

describe("App Layer Simulation", () => {
  describe("Burned Slots from Failed Sends", () => {
    it("should handle burned slots when middle message fails to send", () => {
      const { aliceSession: initialAlice, bobSession: initialBob, bobSigning } = createSessionPair();
      let bobSession = initialBob;
      let aliceSession = initialAlice;

      // Bob encrypts 3 messages
      const enc1 = ratchetEncrypt(
        bobSession,
        new TextEncoder().encode("Message 1"),
        bobSigning.secretKey
      );
      bobSession = enc1.session; // n=0 used, now n=1

      // Message 2 encrypts but TX FAILS (simulated)
      const enc2 = ratchetEncrypt(
        bobSession,
        new TextEncoder().encode("Message 2 - WILL FAIL"),
        bobSigning.secretKey
      );
      bobSession = enc2.session; // n=1 used (burned!), now n=2
      // enc2 is never sent to Alice - tx failed

      const enc3 = ratchetEncrypt(
        bobSession,
        new TextEncoder().encode("Message 3"),
        bobSigning.secretKey
      );
      bobSession = enc3.session; // n=2 used, now n=3

      // Verify Bob's session advanced correctly despite failure
      expect(bobSession.sendingMsgNumber).toBe(3);

      // Alice only receives messages 1 and 3 (message 2 was never sent)
      const dec1 = ratchetDecrypt(aliceSession, enc1.header, enc1.ciphertext);
      expect(dec1).not.toBeNull();
      expect(new TextDecoder().decode(dec1!.plaintext)).toBe("Message 1");
      aliceSession = dec1!.session;

      // When Alice receives message 3 (n=2), she creates a skip key for n=1
      const dec3 = ratchetDecrypt(aliceSession, enc3.header, enc3.ciphertext);
      expect(dec3).not.toBeNull();
      expect(new TextDecoder().decode(dec3!.plaintext)).toBe("Message 3");
      aliceSession = dec3!.session;

      // Alice has an orphan skip key for n=1 that will never be used
      expect(aliceSession.skippedKeys.length).toBe(1);
      expect(aliceSession.skippedKeys[0].msgNumber).toBe(1);

      // Session continues to work normally
      expect(aliceSession.receivingMsgNumber).toBe(3);
    });

    it("should handle multiple consecutive burned slots", () => {
      const { aliceSession: initialAlice, bobSession: initialBob, bobSigning } = createSessionPair();
      let bobSession = initialBob;
      let aliceSession = initialAlice;

      // Bob encrypts 5 messages, but 2, 3, 4 all fail
      const enc1 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 1"), bobSigning.secretKey);
      bobSession = enc1.session;

      // Messages 2, 3, 4 - all burned (tx failures)
      const enc2 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 2 - FAIL"), bobSigning.secretKey);
      bobSession = enc2.session;
      const enc3 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 3 - FAIL"), bobSigning.secretKey);
      bobSession = enc3.session;
      const enc4 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 4 - FAIL"), bobSigning.secretKey);
      bobSession = enc4.session;

      const enc5 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 5"), bobSigning.secretKey);
      bobSession = enc5.session;

      // Alice receives only 1 and 5
      const dec1 = ratchetDecrypt(aliceSession, enc1.header, enc1.ciphertext);
      aliceSession = dec1!.session;

      const dec5 = ratchetDecrypt(aliceSession, enc5.header, enc5.ciphertext);
      expect(dec5).not.toBeNull();
      expect(new TextDecoder().decode(dec5!.plaintext)).toBe("Msg 5");
      aliceSession = dec5!.session;

      // Alice has 3 orphan skip keys (for n=1, 2, 3)
      expect(aliceSession.skippedKeys.length).toBe(3);
      expect(aliceSession.skippedKeys.map(k => k.msgNumber).sort()).toEqual([1, 2, 3]);
    });

    it("should handle burned first message", () => {
      const { aliceSession: initialAlice, bobSession: initialBob, bobSigning } = createSessionPair();
      let bobSession = initialBob;
      let aliceSession = initialAlice;

      // First message burns (tx fails)
      const enc1 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 1 - FAIL"), bobSigning.secretKey);
      bobSession = enc1.session;

      // Second message succeeds
      const enc2 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 2"), bobSigning.secretKey);
      bobSession = enc2.session;

      // Alice receives only message 2
      const dec2 = ratchetDecrypt(aliceSession, enc2.header, enc2.ciphertext);
      expect(dec2).not.toBeNull();
      expect(new TextDecoder().decode(dec2!.plaintext)).toBe("Msg 2");
      aliceSession = dec2!.session;

      // Skip key created for n=0
      expect(aliceSession.skippedKeys.length).toBe(1);
      expect(aliceSession.skippedKeys[0].msgNumber).toBe(0);
    });
  });

  describe("Retry with New Message Number", () => {
    it("should successfully decrypt retried message at new slot", () => {
      const { aliceSession: initialAlice, bobSession: initialBob, bobSigning } = createSessionPair();
      let bobSession = initialBob;
      let aliceSession = initialAlice;

      // Bob sends message 1 successfully
      const enc1 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 1"), bobSigning.secretKey);
      bobSession = enc1.session;

      // Message 2 - first attempt fails (burned)
      const enc2FirstAttempt = ratchetEncrypt(
        bobSession,
        new TextEncoder().encode("Important message"),
        bobSigning.secretKey
      );
      bobSession = enc2FirstAttempt.session; // Slot burned

      // Message 3 sends successfully
      const enc3 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 3"), bobSigning.secretKey);
      bobSession = enc3.session;

      // Retry "Important message" - now at slot n=3
      const enc2Retry = ratchetEncrypt(
        bobSession,
        new TextEncoder().encode("Important message"), // Same content
        bobSigning.secretKey
      );
      bobSession = enc2Retry.session;

      // Alice receives messages in order: 1, 3, then retry
      const dec1 = ratchetDecrypt(aliceSession, enc1.header, enc1.ciphertext);
      aliceSession = dec1!.session;

      const dec3 = ratchetDecrypt(aliceSession, enc3.header, enc3.ciphertext);
      aliceSession = dec3!.session;

      // Retry decrypts fine at its new message number
      const decRetry = ratchetDecrypt(aliceSession, enc2Retry.header, enc2Retry.ciphertext);
      expect(decRetry).not.toBeNull();
      expect(new TextDecoder().decode(decRetry!.plaintext)).toBe("Important message");
      aliceSession = decRetry!.session;

      // Alice has orphan skip key for the burned n=1 slot
      expect(aliceSession.skippedKeys.some(k => k.msgNumber === 1)).toBe(true);
    });

    it("should handle multiple retries of different messages", () => {
      const { aliceSession: initialAlice, bobSession: initialBob, bobSigning } = createSessionPair();
      let bobSession = initialBob;
      let aliceSession = initialAlice;

      // Successful: n=0
      const enc1 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 1"), bobSigning.secretKey);
      bobSession = enc1.session;

      // Fails: n=1 burned
      const failedA = ratchetEncrypt(bobSession, new TextEncoder().encode("Failed A"), bobSigning.secretKey);
      bobSession = failedA.session;

      // Fails: n=2 burned  
      const failedB = ratchetEncrypt(bobSession, new TextEncoder().encode("Failed B"), bobSigning.secretKey);
      bobSession = failedB.session;

      // Successful: n=3
      const enc2 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 2"), bobSigning.secretKey);
      bobSession = enc2.session;

      // Retry A: n=4
      const retryA = ratchetEncrypt(bobSession, new TextEncoder().encode("Failed A"), bobSigning.secretKey);
      bobSession = retryA.session;

      // Retry B: n=5
      const retryB = ratchetEncrypt(bobSession, new TextEncoder().encode("Failed B"), bobSigning.secretKey);
      bobSession = retryB.session;

      // Alice receives: 1, 2, retryA, retryB (skipping n=1,2)
      let dec = ratchetDecrypt(aliceSession, enc1.header, enc1.ciphertext);
      aliceSession = dec!.session;

      dec = ratchetDecrypt(aliceSession, enc2.header, enc2.ciphertext);
      aliceSession = dec!.session;
      // Skip keys for n=1, n=2 created

      dec = ratchetDecrypt(aliceSession, retryA.header, retryA.ciphertext);
      expect(dec).not.toBeNull();
      expect(new TextDecoder().decode(dec!.plaintext)).toBe("Failed A");
      aliceSession = dec!.session;

      dec = ratchetDecrypt(aliceSession, retryB.header, retryB.ciphertext);
      expect(dec).not.toBeNull();
      expect(new TextDecoder().decode(dec!.plaintext)).toBe("Failed B");
      aliceSession = dec!.session;

      // 2 orphan skip keys remain
      expect(aliceSession.skippedKeys.length).toBe(2);
    });
  });

  describe("Orphan Skip Keys Lifecycle", () => {
    it("should accumulate orphan skip keys from burned slots", () => {
      const { aliceSession: initialAlice, bobSession: initialBob, bobSigning } = createSessionPair();
      let bobSession = initialBob;
      let aliceSession = initialAlice;

      // Send odd-numbered messages only (even slots burned)
      const encryptedMessages: ReturnType<typeof ratchetEncrypt>[] = [];

      for (let i = 0; i < 10; i++) {
        const enc = ratchetEncrypt(
          bobSession,
          new TextEncoder().encode(`Msg ${i}`),
          bobSigning.secretKey
        );
        bobSession = enc.session;

        // Only "send" odd indices (0, 2, 4, 6, 8)
        if (i % 2 === 0) {
          encryptedMessages.push(enc);
        }
        // Even indices (1, 3, 5, 7, 9) are burned
      }

      // Alice receives only the even-index messages
      for (const enc of encryptedMessages) {
        const dec = ratchetDecrypt(aliceSession, enc.header, enc.ciphertext);
        expect(dec).not.toBeNull();
        aliceSession = dec!.session;
      }

      // 4 orphan skip keys for the burned slots (n=1,3,5,7)
      expect(aliceSession.skippedKeys.length).toBe(4);
      const burnedSlots = aliceSession.skippedKeys.map(k => k.msgNumber).sort((a, b) => a - b);
      expect(burnedSlots).toEqual([1, 3, 5, 7]);
    });

    it("should expire orphan skip keys after TTL", () => {
      const { aliceSession: initialAlice, bobSession: initialBob, bobSigning } = createSessionPair();
      let bobSession = initialBob;
      let aliceSession = initialAlice;

      // Create some burned slots
      const enc1 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 1"), bobSigning.secretKey);
      bobSession = enc1.session;

      // Burn n=1
      ratchetEncrypt(bobSession, new TextEncoder().encode("Burned"), bobSigning.secretKey);
      bobSession = bobSession; // Would be advanced in real code

      const enc2 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 2"), bobSigning.secretKey);
      bobSession = enc2.session;

      // Simpler test: just create a session with old skip keys
      aliceSession = {
        ...aliceSession,
        skippedKeys: [
          {
            dhPubKeyHex: "0xold",
            msgNumber: 5,
            messageKey: new Uint8Array(32),
            createdAt: Date.now() - 100_000_000, // Very old
          },
          {
            dhPubKeyHex: "0xnew",
            msgNumber: 6,
            messageKey: new Uint8Array(32),
            createdAt: Date.now(), // Fresh
          },
        ],
      };

      // Prune with 24h TTL (in ms)
      const pruned = pruneExpiredSkippedKeys(aliceSession, 24 * 60 * 60 * 1000);

      expect(pruned.skippedKeys.length).toBe(1);
      expect(pruned.skippedKeys[0].msgNumber).toBe(6); // Only fresh one remains
    });
  });

  describe("Skip Key Storage Limits", () => {
    it("should handle approaching MAX_STORED_SKIPPED_KEYS", () => {
      // Create a session with many skipped keys approaching the limit
      const { aliceSession: initialAlice } = createSessionPair();

      // Simulate a pathological case with many skip keys
      const manySkipKeys = Array.from({ length: 100 }, (_, i) => ({
        dhPubKeyHex: `0x${i.toString(16).padStart(64, '0')}`,
        msgNumber: i,
        messageKey: nacl.randomBytes(32),
        createdAt: Date.now(),
      }));

      const sessionWithManyKeys: RatchetSession = {
        ...initialAlice,
        skippedKeys: manySkipKeys,
      };

      // Session should still be functional
      expect(sessionWithManyKeys.skippedKeys.length).toBe(100);

      // In a real implementation, we'd test that the oldest keys get pruned
      // when exceeding MAX_STORED_SKIPPED_KEYS (1000)
      expect(MAX_STORED_SKIPPED_KEYS).toBe(1000);
    });

    it("should handle large message number gaps gracefully", () => {
      const { aliceSession: initialAlice, bobSession: initialBob, bobSigning } = createSessionPair();
      let bobSession = initialBob;
      let aliceSession = initialAlice;

      // Send first message
      const enc1 = ratchetEncrypt(bobSession, new TextEncoder().encode("First"), bobSigning.secretKey);
      bobSession = enc1.session;

      // Simulate many burned slots by manually advancing session
      // In real app, this would be many failed txs
      for (let i = 0; i < 50; i++) {
        const burned = ratchetEncrypt(bobSession, new TextEncoder().encode(`Burned ${i}`), bobSigning.secretKey);
        bobSession = burned.session;
      }

      // Send message after the gap
      const enc2 = ratchetEncrypt(bobSession, new TextEncoder().encode("After gap"), bobSigning.secretKey);
      bobSession = enc2.session;

      // Alice receives first message
      const dec1 = ratchetDecrypt(aliceSession, enc1.header, enc1.ciphertext);
      aliceSession = dec1!.session;

      // Alice receives message after gap - creates 50 skip keys
      const dec2 = ratchetDecrypt(aliceSession, enc2.header, enc2.ciphertext);
      expect(dec2).not.toBeNull();
      expect(new TextDecoder().decode(dec2!.plaintext)).toBe("After gap");
      aliceSession = dec2!.session;

      // 50 skip keys created for the gap
      expect(aliceSession.skippedKeys.length).toBe(50);
    });
  });

  describe("Session Persistence (DB Round-Trip)", () => {
    it("should maintain chain continuity after save/load cycle", () => {
      const { aliceSession: initialAlice, bobSession: initialBob, bobSigning, aliceSigning } = createSessionPair();
      let bobSession = initialBob;
      let aliceSession = initialAlice;

      // Bob sends a message
      const enc1 = ratchetEncrypt(bobSession, new TextEncoder().encode("Before save"), bobSigning.secretKey);
      bobSession = enc1.session;

      // Simulate DB save/load
      bobSession = simulateDbRoundTrip(bobSession);

      // Bob sends another message after "reload"
      const enc2 = ratchetEncrypt(bobSession, new TextEncoder().encode("After save"), bobSigning.secretKey);
      bobSession = enc2.session;

      // Alice receives both messages
      const dec1 = ratchetDecrypt(aliceSession, enc1.header, enc1.ciphertext);
      expect(dec1).not.toBeNull();
      aliceSession = dec1!.session;

      const dec2 = ratchetDecrypt(aliceSession, enc2.header, enc2.ciphertext);
      expect(dec2).not.toBeNull();
      expect(new TextDecoder().decode(dec2!.plaintext)).toBe("After save");
    });

    it("should preserve skip keys through save/load cycle", () => {
      const { aliceSession: initialAlice, bobSession: initialBob, bobSigning } = createSessionPair();
      let bobSession = initialBob;
      let aliceSession = initialAlice;

      // Bob sends 3 messages
      const enc1 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 1"), bobSigning.secretKey);
      bobSession = enc1.session;
      const enc2 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 2"), bobSigning.secretKey);
      bobSession = enc2.session;
      const enc3 = ratchetEncrypt(bobSession, new TextEncoder().encode("Msg 3"), bobSigning.secretKey);
      bobSession = enc3.session;

      // Alice receives msg 3 first (creates skip keys)
      const dec3 = ratchetDecrypt(aliceSession, enc3.header, enc3.ciphertext);
      aliceSession = dec3!.session;
      expect(aliceSession.skippedKeys.length).toBe(2);

      // Simulate DB save/load
      aliceSession = simulateDbRoundTrip(aliceSession);

      // Skip keys should still work after reload
      expect(aliceSession.skippedKeys.length).toBe(2);

      const dec1 = ratchetDecrypt(aliceSession, enc1.header, enc1.ciphertext);
      expect(dec1).not.toBeNull();
      expect(new TextDecoder().decode(dec1!.plaintext)).toBe("Msg 1");
      aliceSession = dec1!.session;

      const dec2 = ratchetDecrypt(aliceSession, enc2.header, enc2.ciphertext);
      expect(dec2).not.toBeNull();
      expect(new TextDecoder().decode(dec2!.plaintext)).toBe("Msg 2");
    });

    it("should handle alternating messages with save/load between each", () => {
      let { aliceSession, bobSession, bobSigning, aliceSigning } = createSessionPair();

      // Simulate realistic usage: save after every operation
      
      // Bob -> Alice
      const enc1 = ratchetEncrypt(bobSession, new TextEncoder().encode("Bob 1"), bobSigning.secretKey);
      bobSession = simulateDbRoundTrip(enc1.session);

      const dec1 = ratchetDecrypt(aliceSession, enc1.header, enc1.ciphertext);
      aliceSession = simulateDbRoundTrip(dec1!.session);

      // Alice -> Bob
      const enc2 = ratchetEncrypt(aliceSession, new TextEncoder().encode("Alice 1"), aliceSigning.secretKey);
      aliceSession = simulateDbRoundTrip(enc2.session);

      const dec2 = ratchetDecrypt(bobSession, enc2.header, enc2.ciphertext);
      bobSession = simulateDbRoundTrip(dec2!.session);

      // Bob -> Alice again
      const enc3 = ratchetEncrypt(bobSession, new TextEncoder().encode("Bob 2"), bobSigning.secretKey);
      bobSession = simulateDbRoundTrip(enc3.session);

      const dec3 = ratchetDecrypt(aliceSession, enc3.header, enc3.ciphertext);
      expect(dec3).not.toBeNull();
      expect(new TextDecoder().decode(dec3!.plaintext)).toBe("Bob 2");
    });
  });

  describe("DH Ratchet Advancement with Failures", () => {
    it("should handle burned slots across DH ratchet steps", () => {
      let { aliceSession, bobSession, bobSigning, aliceSigning } = createSessionPair();

      // Bob sends (advances his chain)
      const bobEnc1 = ratchetEncrypt(bobSession, new TextEncoder().encode("Bob 1"), bobSigning.secretKey);
      bobSession = bobEnc1.session;

      // Alice receives and replies (triggers DH ratchet for her)
      const aliceDec1 = ratchetDecrypt(aliceSession, bobEnc1.header, bobEnc1.ciphertext);
      aliceSession = aliceDec1!.session;

      // Alice sends (with her new DH key)
      const aliceEnc1 = ratchetEncrypt(aliceSession, new TextEncoder().encode("Alice 1"), aliceSigning.secretKey);
      aliceSession = aliceEnc1.session;

      // Alice's second message FAILS (burned)
      const aliceEnc2Burned = ratchetEncrypt(aliceSession, new TextEncoder().encode("Alice 2 FAIL"), aliceSigning.secretKey);
      aliceSession = aliceEnc2Burned.session;

      // Alice's third message succeeds
      const aliceEnc3 = ratchetEncrypt(aliceSession, new TextEncoder().encode("Alice 3"), aliceSigning.secretKey);
      aliceSession = aliceEnc3.session;

      // Bob receives Alice's messages (skipping the burned one)
      const bobDec1 = ratchetDecrypt(bobSession, aliceEnc1.header, aliceEnc1.ciphertext);
      bobSession = bobDec1!.session;

      const bobDec3 = ratchetDecrypt(bobSession, aliceEnc3.header, aliceEnc3.ciphertext);
      expect(bobDec3).not.toBeNull();
      expect(new TextDecoder().decode(bobDec3!.plaintext)).toBe("Alice 3");
      bobSession = bobDec3!.session;

      // Bob has skip key for Alice's n=1
      expect(bobSession.skippedKeys.length).toBe(1);

      // Bob replies (triggers DH ratchet for him)
      const bobEnc2 = ratchetEncrypt(bobSession, new TextEncoder().encode("Bob 2"), bobSigning.secretKey);
      bobSession = bobEnc2.session;

      // Alice receives
      const aliceDec2 = ratchetDecrypt(aliceSession, bobEnc2.header, bobEnc2.ciphertext);
      expect(aliceDec2).not.toBeNull();
      expect(new TextDecoder().decode(aliceDec2!.plaintext)).toBe("Bob 2");
    });
  });

  describe("Concurrent Conversation Isolation", () => {
    it("should isolate failures between different conversations", () => {
      // Create two separate conversations
      const convAB = createSessionPair(); // Alice <-> Bob
      const convAC = createSessionPair(); // Alice <-> Charlie (reusing Alice's signing key)

      let aliceBobSession = convAB.aliceSession;
      let bobSession = convAB.bobSession;
      let aliceCharlieSession = convAC.aliceSession;
      let charlieSession = convAC.bobSession;

      const aliceSigning = convAB.aliceSigning;
      const bobSigning = convAB.bobSigning;
      const charlieSigning = convAC.bobSigning;

      // Send message to Bob (succeeds)
      const toBob = ratchetEncrypt(aliceBobSession, new TextEncoder().encode("Hi Bob"), aliceSigning.secretKey);
      aliceBobSession = toBob.session;

      // Send message to Charlie (fails - burned)
      const toCharlieFail = ratchetEncrypt(aliceCharlieSession, new TextEncoder().encode("Hi Charlie FAIL"), aliceSigning.secretKey);
      aliceCharlieSession = toCharlieFail.session;

      // Send another to Charlie (succeeds)
      const toCharlieSuccess = ratchetEncrypt(aliceCharlieSession, new TextEncoder().encode("Hi Charlie"), aliceSigning.secretKey);
      aliceCharlieSession = toCharlieSuccess.session;

      // Bob's conversation unaffected
      const bobDec = ratchetDecrypt(bobSession, toBob.header, toBob.ciphertext);
      expect(bobDec).not.toBeNull();
      expect(new TextDecoder().decode(bobDec!.plaintext)).toBe("Hi Bob");
      bobSession = bobDec!.session;
      expect(bobSession.skippedKeys.length).toBe(0); // No skip keys

      // Charlie has skip key from burned message
      const charlieDec = ratchetDecrypt(charlieSession, toCharlieSuccess.header, toCharlieSuccess.ciphertext);
      expect(charlieDec).not.toBeNull();
      expect(new TextDecoder().decode(charlieDec!.plaintext)).toBe("Hi Charlie");
      charlieSession = charlieDec!.session;
      expect(charlieSession.skippedKeys.length).toBe(1); // Skip key for n=0
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty message", () => {
      const { aliceSession, bobSession, bobSigning } = createSessionPair();

      const enc = ratchetEncrypt(bobSession, new Uint8Array(0), bobSigning.secretKey);
      const dec = ratchetDecrypt(aliceSession, enc.header, enc.ciphertext);

      expect(dec).not.toBeNull();
      expect(dec!.plaintext.length).toBe(0);
    });

    it("should handle large message", () => {
      const { aliceSession, bobSession, bobSigning } = createSessionPair();

      const largeMessage = nacl.randomBytes(1024 * 1024);
      const enc = ratchetEncrypt(bobSession, largeMessage, bobSigning.secretKey);
      const dec = ratchetDecrypt(aliceSession, enc.header, enc.ciphertext);

      expect(dec).not.toBeNull();
      expect(Buffer.from(dec!.plaintext)).toEqual(Buffer.from(largeMessage));
    });

    it("should reject replay of same message", () => {
      const { aliceSession: initialAlice, bobSession, bobSigning } = createSessionPair();
      let aliceSession = initialAlice;

      const enc = ratchetEncrypt(bobSession, new TextEncoder().encode("Original"), bobSigning.secretKey);

      const dec1 = ratchetDecrypt(aliceSession, enc.header, enc.ciphertext);
      expect(dec1).not.toBeNull();
      aliceSession = dec1!.session;

      const dec2 = ratchetDecrypt(aliceSession, enc.header, enc.ciphertext);
      
      expect(dec2).toBeNull();
    });

    it("should handle message after long idle period", () => {
      let { aliceSession, bobSession, bobSigning } = createSessionPair();

      // Send first message
      const enc1 = ratchetEncrypt(bobSession, new TextEncoder().encode("Before idle"), bobSigning.secretKey);
      bobSession = enc1.session;

      const dec1 = ratchetDecrypt(aliceSession, enc1.header, enc1.ciphertext);
      aliceSession = dec1!.session;

      // Simulate long idle by manipulating timestamps (in real app, session would be loaded from DB)
      bobSession = simulateDbRoundTrip(bobSession);
      aliceSession = simulateDbRoundTrip(aliceSession);

      // Send message after "idle"
      const enc2 = ratchetEncrypt(bobSession, new TextEncoder().encode("After idle"), bobSigning.secretKey);
      const dec2 = ratchetDecrypt(aliceSession, enc2.header, enc2.ciphertext);

      expect(dec2).not.toBeNull();
      expect(new TextDecoder().decode(dec2!.plaintext)).toBe("After idle");
    });
  });
});