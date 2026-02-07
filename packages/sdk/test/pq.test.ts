// packages/sdk/test/pq.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import nacl from 'tweetnacl';

import { kem } from '../src/pq/kem.js';
import { hybridInitialSecret } from '../src/ratchet/kdf.js';
import {
  initSessionAsResponder,
  initSessionAsInitiator,
  ratchetEncrypt,
  ratchetDecrypt,
} from '../src/ratchet/index.js';
import { createEphemeralPair, createSigningKeyPair } from './helpers.js';

describe('kem', () => {
  it('generates keypair with correct sizes', () => {
    const keyPair = kem.generateKeyPair();

    expect(keyPair.publicKey.length).toBe(kem.publicKeyBytes);
    expect(keyPair.secretKey.length).toBeGreaterThan(0);
  });

  it('encapsulate/decapsulate round-trip produces matching secrets', () => {
    const keyPair = kem.generateKeyPair();

    const { ciphertext, sharedSecret: encapSecret } = kem.encapsulate(keyPair.publicKey);

    expect(ciphertext.length).toBe(kem.ciphertextBytes);
    expect(encapSecret.length).toBe(kem.sharedSecretBytes);

    const decapSecret = kem.decapsulate(ciphertext, keyPair.secretKey);

    expect(decapSecret.length).toBe(kem.sharedSecretBytes);
    expect(decapSecret).toEqual(encapSecret);
  });

  it('different keypairs produce different shared secrets', () => {
    const keyPair1 = kem.generateKeyPair();
    const keyPair2 = kem.generateKeyPair();

    const { sharedSecret: secret1 } = kem.encapsulate(keyPair1.publicKey);
    const { sharedSecret: secret2 } = kem.encapsulate(keyPair2.publicKey);

    expect(secret1).not.toEqual(secret2);
  });

  it('same public key with different encapsulations produces different secrets', () => {
    const keyPair = kem.generateKeyPair();

    const { sharedSecret: secret1, ciphertext: ct1 } = kem.encapsulate(keyPair.publicKey);
    const { sharedSecret: secret2, ciphertext: ct2 } = kem.encapsulate(keyPair.publicKey);

    expect(ct1).not.toEqual(ct2);
    expect(secret1).not.toEqual(secret2);
  });
});

describe('hybridInitialSecret', () => {
  it('produces deterministic output for same inputs', () => {
    const x25519Secret = nacl.randomBytes(32);
    const kemSecret = nacl.randomBytes(32);

    const result1 = hybridInitialSecret(x25519Secret, kemSecret);
    const result2 = hybridInitialSecret(x25519Secret, kemSecret);

    expect(result1).toEqual(result2);
    expect(result1.length).toBe(32);
  });

  it('produces different output from X25519-only', () => {
    const x25519Secret = nacl.randomBytes(32);
    const kemSecret = nacl.randomBytes(32);

    const hybridResult = hybridInitialSecret(x25519Secret, kemSecret);

    // Hybrid result should differ from either input
    expect(hybridResult).not.toEqual(x25519Secret);
    expect(hybridResult).not.toEqual(kemSecret);
  });

  it('produces different output for different KEM secrets', () => {
    const x25519Secret = nacl.randomBytes(32);
    const kemSecret1 = nacl.randomBytes(32);
    const kemSecret2 = nacl.randomBytes(32);

    const result1 = hybridInitialSecret(x25519Secret, kemSecret1);
    const result2 = hybridInitialSecret(x25519Secret, kemSecret2);

    expect(result1).not.toEqual(result2);
  });

  it('produces different output for different X25519 secrets', () => {
    const x25519Secret1 = nacl.randomBytes(32);
    const x25519Secret2 = nacl.randomBytes(32);
    const kemSecret = nacl.randomBytes(32);

    const result1 = hybridInitialSecret(x25519Secret1, kemSecret);
    const result2 = hybridInitialSecret(x25519Secret2, kemSecret);

    expect(result1).not.toEqual(result2);
  });
});

describe('PQ-hybrid session initialization', () => {
  let aliceEphemeral: { secretKey: Uint8Array; publicKey: Uint8Array };
  let bobEphemeral: { secretKey: Uint8Array; publicKey: Uint8Array };
  let kemKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
  let kemSharedSecret: Uint8Array;

  const topicAliceToBob = '0x' + 'a'.repeat(64) as `0x${string}`;
  const topicBobToAlice = '0x' + 'b'.repeat(64) as `0x${string}`;

  beforeEach(() => {
    aliceEphemeral = createEphemeralPair();
    bobEphemeral = createEphemeralPair();
    kemKeyPair = kem.generateKeyPair();

    // Bob encapsulates to Alice's KEM public key
    const encapResult = kem.encapsulate(kemKeyPair.publicKey);
    kemSharedSecret = encapResult.sharedSecret;
  });

  it('both parties derive matching root keys with hybrid KDF', () => {
    // Alice is initiator, Bob is responder
    // Alice decapsulates KEM ciphertext to get kemSecret
    // Both use same kemSecret for hybrid KDF

    const bobSession = initSessionAsResponder({
      myAddress: '0xBob',
      contactAddress: '0xAlice',
      myResponderEphemeralSecret: bobEphemeral.secretKey,
      myResponderEphemeralPublic: bobEphemeral.publicKey,
      theirHandshakeEphemeralPubKey: aliceEphemeral.publicKey,
      topicOutbound: topicBobToAlice,
      topicInbound: topicAliceToBob,
      kemSecret: kemSharedSecret,
    });

    const aliceSession = initSessionAsInitiator({
      myAddress: '0xAlice',
      contactAddress: '0xBob',
      myHandshakeEphemeralSecret: aliceEphemeral.secretKey,
      theirResponderEphemeralPubKey: bobEphemeral.publicKey,
      topicOutbound: topicAliceToBob,
      topicInbound: topicBobToAlice,
      kemSecret: kemSharedSecret,
    });

    // Root keys should allow message exchange
    const signingKeyPair = createSigningKeyPair();

    // Alice encrypts
    const plaintext = new TextEncoder().encode('Hello Bob with PQ security!');
    const encryptResult = ratchetEncrypt(aliceSession, plaintext, signingKeyPair.secretKey);

    // Bob decrypts
    const decryptResult = ratchetDecrypt(bobSession, encryptResult.header, encryptResult.ciphertext);

    expect(decryptResult).not.toBeNull();
    expect(new TextDecoder().decode(decryptResult!.plaintext)).toBe('Hello Bob with PQ security!');
  });

  it('hybrid sessions differ from non-hybrid sessions', () => {
    // Non-hybrid session
    const nonHybridBobSession = initSessionAsResponder({
      myAddress: '0xBob',
      contactAddress: '0xAlice',
      myResponderEphemeralSecret: bobEphemeral.secretKey,
      myResponderEphemeralPublic: bobEphemeral.publicKey,
      theirHandshakeEphemeralPubKey: aliceEphemeral.publicKey,
      topicOutbound: topicBobToAlice,
      topicInbound: topicAliceToBob,
      // No kemSecret
    });

    // Hybrid session
    const hybridBobSession = initSessionAsResponder({
      myAddress: '0xBob',
      contactAddress: '0xAlice',
      myResponderEphemeralSecret: bobEphemeral.secretKey,
      myResponderEphemeralPublic: bobEphemeral.publicKey,
      theirHandshakeEphemeralPubKey: aliceEphemeral.publicKey,
      topicOutbound: topicBobToAlice,
      topicInbound: topicAliceToBob,
      kemSecret: kemSharedSecret,
    });

    // Root keys should be different
    expect(nonHybridBobSession.rootKey).not.toEqual(hybridBobSession.rootKey);
  });

  it('mismatched KEM secrets prevent decryption', () => {
    // Bob uses correct kemSecret
    const bobSession = initSessionAsResponder({
      myAddress: '0xBob',
      contactAddress: '0xAlice',
      myResponderEphemeralSecret: bobEphemeral.secretKey,
      myResponderEphemeralPublic: bobEphemeral.publicKey,
      theirHandshakeEphemeralPubKey: aliceEphemeral.publicKey,
      topicOutbound: topicBobToAlice,
      topicInbound: topicAliceToBob,
      kemSecret: kemSharedSecret,
    });

    // Alice uses wrong kemSecret
    const wrongKemSecret = nacl.randomBytes(32);
    const aliceSession = initSessionAsInitiator({
      myAddress: '0xAlice',
      contactAddress: '0xBob',
      myHandshakeEphemeralSecret: aliceEphemeral.secretKey,
      theirResponderEphemeralPubKey: bobEphemeral.publicKey,
      topicOutbound: topicAliceToBob,
      topicInbound: topicBobToAlice,
      kemSecret: wrongKemSecret,
    });

    const signingKeyPair = createSigningKeyPair();
    const plaintext = new TextEncoder().encode('This should fail');
    const encryptResult = ratchetEncrypt(aliceSession, plaintext, signingKeyPair.secretKey);

    // Bob should not be able to decrypt (wrong root key derivation)
    const decryptResult = ratchetDecrypt(bobSession, encryptResult.header, encryptResult.ciphertext);
    expect(decryptResult).toBeNull();
  });
});

describe('backward compatibility', () => {
  it('sessions without kemSecret still work', () => {
    const aliceEphemeral = createEphemeralPair();
    const bobEphemeral = createEphemeralPair();

    const topicAliceToBob = '0x' + 'a'.repeat(64) as `0x${string}`;
    const topicBobToAlice = '0x' + 'b'.repeat(64) as `0x${string}`;

    // Sessions without kemSecret (backward compatible)
    const bobSession = initSessionAsResponder({
      myAddress: '0xBob',
      contactAddress: '0xAlice',
      myResponderEphemeralSecret: bobEphemeral.secretKey,
      myResponderEphemeralPublic: bobEphemeral.publicKey,
      theirHandshakeEphemeralPubKey: aliceEphemeral.publicKey,
      topicOutbound: topicBobToAlice,
      topicInbound: topicAliceToBob,
    });

    const aliceSession = initSessionAsInitiator({
      myAddress: '0xAlice',
      contactAddress: '0xBob',
      myHandshakeEphemeralSecret: aliceEphemeral.secretKey,
      theirResponderEphemeralPubKey: bobEphemeral.publicKey,
      topicOutbound: topicAliceToBob,
      topicInbound: topicBobToAlice,
    });

    const signingKeyPair = createSigningKeyPair();
    const plaintext = new TextEncoder().encode('Classic X25519 only');
    const encryptResult = ratchetEncrypt(aliceSession, plaintext, signingKeyPair.secretKey);

    const decryptResult = ratchetDecrypt(bobSession, encryptResult.header, encryptResult.ciphertext);

    expect(decryptResult).not.toBeNull();
    expect(new TextDecoder().decode(decryptResult!.plaintext)).toBe('Classic X25519 only');
  });
});
