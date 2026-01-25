// packages/sdk/test/ratchet.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import nacl from 'tweetnacl';

import {
  deriveTopic,
  initSessionAsResponder,
  initSessionAsInitiator,
  ratchetEncrypt,
  ratchetDecrypt,
  matchesSessionTopic,
  type RatchetSession,
} from '../src/ratchet/index.js';

describe('deriveTopic (PQ-secure)', () => {
  it('derives deterministic topic from rootKey + dhOutput', () => {
    const rootKey = nacl.randomBytes(32);
    const dhOutput = nacl.randomBytes(32);

    const topic1 = deriveTopic(rootKey, dhOutput, 'outbound');
    const topic2 = deriveTopic(rootKey, dhOutput, 'outbound');

    expect(topic1).toBe(topic2);
    expect(topic1).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('derives different topics for different rootKeys (PQ-unlinkability)', () => {
    const rootKey1 = nacl.randomBytes(32);
    const rootKey2 = nacl.randomBytes(32);
    const dhOutput = nacl.randomBytes(32); // SAME dhOutput

    const topic1 = deriveTopic(rootKey1, dhOutput, 'outbound');
    const topic2 = deriveTopic(rootKey2, dhOutput, 'outbound');

    // Key property: quantum adversary who knows dhOutput
    // but not rootKey cannot derive the topic
    expect(topic1).not.toBe(topic2);
  });

  it('derives different topics for different dhOutputs', () => {
    const rootKey = nacl.randomBytes(32);
    const dhOutput1 = nacl.randomBytes(32);
    const dhOutput2 = nacl.randomBytes(32);

    const topic1 = deriveTopic(rootKey, dhOutput1, 'outbound');
    const topic2 = deriveTopic(rootKey, dhOutput2, 'outbound');

    expect(topic1).not.toBe(topic2);
  });

  it('derives different topics for outbound vs inbound', () => {
    const rootKey = nacl.randomBytes(32);
    const dhOutput = nacl.randomBytes(32);

    const topicOut = deriveTopic(rootKey, dhOutput, 'outbound');
    const topicIn = deriveTopic(rootKey, dhOutput, 'inbound');

    expect(topicOut).not.toBe(topicIn);
  });
});

describe('initSessionAsResponder - topic ratcheting', () => {
  let responderEphemeral: { secretKey: Uint8Array; publicKey: Uint8Array };
  let initiatorEphemeral: { secretKey: Uint8Array; publicKey: Uint8Array };
  const topicOutbound = '0x' + '1'.repeat(64) as `0x${string}`;
  const topicInbound = '0x' + '2'.repeat(64) as `0x${string}`;

  beforeEach(() => {
    responderEphemeral = nacl.box.keyPair();
    initiatorEphemeral = nacl.box.keyPair();
  });

  it('initializes at epoch 0 with handshake-derived topics', () => {
    const session = initSessionAsResponder({
      myAddress: '0xResponder',
      contactAddress: '0xInitiator',
      myResponderEphemeralSecret: responderEphemeral.secretKey,
      myResponderEphemeralPublic: responderEphemeral.publicKey,
      theirHandshakeEphemeralPubKey: initiatorEphemeral.publicKey,
      topicOutbound,
      topicInbound,
    });

    expect(session.topicEpoch).toBe(0);
    expect(session.currentTopicOutbound).toBe(topicOutbound);
    expect(session.currentTopicInbound).toBe(topicInbound);
    expect(session.previousTopicInbound).toBeUndefined();
    expect(session.previousTopicExpiry).toBeUndefined();
  });

  it('preserves original handshake topics in topicOutbound/topicInbound', () => {
    const session = initSessionAsResponder({
      myAddress: '0xResponder',
      contactAddress: '0xInitiator',
      myResponderEphemeralSecret: responderEphemeral.secretKey,
      myResponderEphemeralPublic: responderEphemeral.publicKey,
      theirHandshakeEphemeralPubKey: initiatorEphemeral.publicKey,
      topicOutbound,
      topicInbound,
    });

    // Original topics preserved for reference
    expect(session.topicOutbound).toBe(topicOutbound);
    expect(session.topicInbound).toBe(topicInbound);
  });
});

describe('initSessionAsInitiator - topic ratcheting', () => {
  let responderEphemeral: { secretKey: Uint8Array; publicKey: Uint8Array };
  let initiatorEphemeral: { secretKey: Uint8Array; publicKey: Uint8Array };
  const topicOutbound = '0x' + '1'.repeat(64) as `0x${string}`;
  const topicInbound = '0x' + '2'.repeat(64) as `0x${string}`;

  beforeEach(() => {
    responderEphemeral = nacl.box.keyPair();
    initiatorEphemeral = nacl.box.keyPair();
  });

  it('initializes at epoch 0 with handshake topics as current, pre-computes next topics', () => {
    const session = initSessionAsInitiator({
      myAddress: '0xInitiator',
      contactAddress: '0xResponder',
      myHandshakeEphemeralSecret: initiatorEphemeral.secretKey,
      theirResponderEphemeralPubKey: responderEphemeral.publicKey,
      topicOutbound,
      topicInbound,
    });

    // Initiator starts at epoch 0
    expect(session.topicEpoch).toBe(0);
    // Current topics are handshake-derived
    expect(session.currentTopicOutbound).toBe(topicOutbound);
    expect(session.currentTopicInbound).toBe(topicInbound);
    // Next topics are pre-computed for when responder does DH ratchet
    expect(session.nextTopicOutbound).toBeDefined();
    expect(session.nextTopicInbound).toBeDefined();
    expect(session.nextTopicOutbound).not.toBe(topicOutbound);
    expect(session.nextTopicInbound).not.toBe(topicInbound);
  });

  it('preserves original handshake topics in topicOutbound/topicInbound', () => {
    const session = initSessionAsInitiator({
      myAddress: '0xInitiator',
      contactAddress: '0xResponder',
      myHandshakeEphemeralSecret: initiatorEphemeral.secretKey,
      theirResponderEphemeralPubKey: responderEphemeral.publicKey,
      topicOutbound,
      topicInbound,
    });

    // Original topics preserved for reference/lookup
    expect(session.topicOutbound).toBe(topicOutbound);
    expect(session.topicInbound).toBe(topicInbound);
  });
});

describe('matchesSessionTopic', () => {
  let session: RatchetSession;

  beforeEach(() => {
    const responderEphemeral = nacl.box.keyPair();
    const initiatorEphemeral = nacl.box.keyPair();

    session = initSessionAsInitiator({
      myAddress: '0xInitiator',
      contactAddress: '0xResponder',
      myHandshakeEphemeralSecret: initiatorEphemeral.secretKey,
      theirResponderEphemeralPubKey: responderEphemeral.publicKey,
      topicOutbound: '0x' + '1'.repeat(64) as `0x${string}`,
      topicInbound: '0x' + '2'.repeat(64) as `0x${string}`,
    });
  });

  it('returns "current" for current inbound topic', () => {
    const result = matchesSessionTopic(session, session.currentTopicInbound);
    expect(result).toBe('current');
  });

  it('returns "current" for current inbound topic (case insensitive)', () => {
    const upperTopic = session.currentTopicInbound.toUpperCase() as `0x${string}`;
    const result = matchesSessionTopic(session, upperTopic);
    expect(result).toBe('current');
  });

  it('returns null for unknown topic', () => {
    const unknownTopic = '0x' + 'f'.repeat(64) as `0x${string}`;
    const result = matchesSessionTopic(session, unknownTopic);
    expect(result).toBeNull();
  });
});

describe('ratchetEncrypt - topic in result', () => {
  let session: RatchetSession;
  let signingKeyPair: nacl.SignKeyPair;

  beforeEach(() => {
    const responderEphemeral = nacl.box.keyPair();
    const initiatorEphemeral = nacl.box.keyPair();
    signingKeyPair = nacl.sign.keyPair();

    session = initSessionAsInitiator({
      myAddress: '0xInitiator',
      contactAddress: '0xResponder',
      myHandshakeEphemeralSecret: initiatorEphemeral.secretKey,
      theirResponderEphemeralPubKey: responderEphemeral.publicKey,
      topicOutbound: '0x' + '1'.repeat(64) as `0x${string}`,
      topicInbound: '0x' + '2'.repeat(64) as `0x${string}`,
    });
  });

  it('includes currentTopicOutbound in encrypt result', () => {
    const plaintext = new TextEncoder().encode('Hello');
    const result = ratchetEncrypt(session, plaintext, signingKeyPair.secretKey);

    expect(result.topic).toBe(session.currentTopicOutbound);
    expect(result.topic).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('returns handshake topic for responder at epoch 0', () => {
    const responderEphemeral = nacl.box.keyPair();
    const initiatorEphemeral = nacl.box.keyPair();
    const topicOutbound = '0x' + '3'.repeat(64) as `0x${string}`;

    const responderSession = initSessionAsResponder({
      myAddress: '0xResponder',
      contactAddress: '0xInitiator',
      myResponderEphemeralSecret: responderEphemeral.secretKey,
      myResponderEphemeralPublic: responderEphemeral.publicKey,
      theirHandshakeEphemeralPubKey: initiatorEphemeral.publicKey,
      topicOutbound,
      topicInbound: '0x' + '4'.repeat(64) as `0x${string}`,
    });

    const plaintext = new TextEncoder().encode('Hello');
    const result = ratchetEncrypt(responderSession, plaintext, signingKeyPair.secretKey);

    // Responder at epoch 0 uses handshake topic
    expect(result.topic).toBe(topicOutbound);
  });
});

describe('DH ratchet step - topic rotation', () => {
  let aliceSession: RatchetSession;
  let bobSession: RatchetSession;
  let aliceSigningKeyPair: nacl.SignKeyPair;
  let bobSigningKeyPair: nacl.SignKeyPair;

  beforeEach(() => {
    // Simulate handshake
    const aliceEphemeral = nacl.box.keyPair();
    const bobEphemeral = nacl.box.keyPair();
    aliceSigningKeyPair = nacl.sign.keyPair();
    bobSigningKeyPair = nacl.sign.keyPair();

    const topicAliceToBob = '0x' + 'a'.repeat(64) as `0x${string}`;
    const topicBobToAlice = '0x' + 'b'.repeat(64) as `0x${string}`;

    // Bob is responder
    bobSession = initSessionAsResponder({
      myAddress: '0xBob',
      contactAddress: '0xAlice',
      myResponderEphemeralSecret: bobEphemeral.secretKey,
      myResponderEphemeralPublic: bobEphemeral.publicKey,
      theirHandshakeEphemeralPubKey: aliceEphemeral.publicKey,
      topicOutbound: topicBobToAlice,
      topicInbound: topicAliceToBob,
    });

    // Alice is initiator
    aliceSession = initSessionAsInitiator({
      myAddress: '0xAlice',
      contactAddress: '0xBob',
      myHandshakeEphemeralSecret: aliceEphemeral.secretKey,
      theirResponderEphemeralPubKey: bobEphemeral.publicKey,
      topicOutbound: topicAliceToBob,
      topicInbound: topicBobToAlice,
    });
  });

  it('both parties start at epoch 0', () => {
    expect(aliceSession.topicEpoch).toBe(0);
    expect(bobSession.topicEpoch).toBe(0);
  });

  it('Bob advances to epoch 1 after receiving message from Alice', () => {
    // Alice encrypts a message
    const plaintext = new TextEncoder().encode('Hello Bob');
    const encryptResult = ratchetEncrypt(aliceSession, plaintext, aliceSigningKeyPair.secretKey);
    aliceSession = encryptResult.session;

    // Bob decrypts - this triggers DH ratchet step
    const decryptResult = ratchetDecrypt(bobSession, encryptResult.header, encryptResult.ciphertext);
    expect(decryptResult).not.toBeNull();
    bobSession = decryptResult!.session;

    expect(bobSession.topicEpoch).toBe(1);
    expect(bobSession.currentTopicOutbound).not.toBe(bobSession.topicOutbound);
    expect(bobSession.currentTopicInbound).not.toBe(bobSession.topicInbound);
  });

  it('both parties derive matching topics after DH ratchet', () => {
    // Alice encrypts a message
    const plaintext = new TextEncoder().encode('Hello Bob');
    const encryptResult = ratchetEncrypt(aliceSession, plaintext, aliceSigningKeyPair.secretKey);
    aliceSession = encryptResult.session;

    // Bob decrypts (triggers his DH ratchet)
    const decryptResult = ratchetDecrypt(bobSession, encryptResult.header, encryptResult.ciphertext);
    bobSession = decryptResult!.session;

    // Bob's new outbound should match Alice's pre-computed nextTopicInbound
    expect(bobSession.currentTopicOutbound).toBe(aliceSession.nextTopicInbound);
    // Bob's new inbound should match Alice's pre-computed nextTopicOutbound  
    expect(bobSession.currentTopicInbound).toBe(aliceSession.nextTopicOutbound);
  });

  it('previous topic is preserved during transition window after DH ratchet', () => {
    // Alice encrypts a message
    const plaintext = new TextEncoder().encode('Hello Bob');
    const encryptResult = ratchetEncrypt(aliceSession, plaintext, aliceSigningKeyPair.secretKey);
    aliceSession = encryptResult.session;

    // Bob decrypts
    const decryptResult = ratchetDecrypt(bobSession, encryptResult.header, encryptResult.ciphertext);
    bobSession = decryptResult!.session;

    // Bob should have previous topic set (after DH ratchet, not at init)
    expect(bobSession.previousTopicInbound).toBeDefined();
    expect(bobSession.previousTopicExpiry).toBeDefined();
    expect(bobSession.previousTopicExpiry!).toBeGreaterThan(Date.now());
  });

  it('full conversation rotates topics correctly', () => {
    const epochs: { alice: number; bob: number }[] = [];

    // Track initial state - both at epoch 0
    epochs.push({ alice: aliceSession.topicEpoch, bob: bobSession.topicEpoch });

    // Alice -> Bob (Alice at epoch 0, Bob will ratchet to 1)
    let encryptResult = ratchetEncrypt(aliceSession, new TextEncoder().encode('msg1'), aliceSigningKeyPair.secretKey);
    aliceSession = encryptResult.session;
    let decryptResult = ratchetDecrypt(bobSession, encryptResult.header, encryptResult.ciphertext);
    bobSession = decryptResult!.session;
    epochs.push({ alice: aliceSession.topicEpoch, bob: bobSession.topicEpoch });

    // Bob -> Alice (Bob at epoch 1, Alice will ratchet to 1)
    encryptResult = ratchetEncrypt(bobSession, new TextEncoder().encode('msg2'), bobSigningKeyPair.secretKey);
    bobSession = encryptResult.session;
    decryptResult = ratchetDecrypt(aliceSession, encryptResult.header, encryptResult.ciphertext);
    aliceSession = decryptResult!.session;
    epochs.push({ alice: aliceSession.topicEpoch, bob: bobSession.topicEpoch });

    // Alice -> Bob (Alice at epoch 1, Bob will ratchet to 2)
    encryptResult = ratchetEncrypt(aliceSession, new TextEncoder().encode('msg3'), aliceSigningKeyPair.secretKey);
    aliceSession = encryptResult.session;
    decryptResult = ratchetDecrypt(bobSession, encryptResult.header, encryptResult.ciphertext);
    bobSession = decryptResult!.session;
    epochs.push({ alice: aliceSession.topicEpoch, bob: bobSession.topicEpoch });

    // Verify epochs increment with each turn change
    expect(epochs[0]).toEqual({ alice: 0, bob: 0 });
    expect(epochs[1]).toEqual({ alice: 0, bob: 1 });
    expect(epochs[2]).toEqual({ alice: 1, bob: 1 });
    expect(epochs[3]).toEqual({ alice: 1, bob: 2 });
  });
});

describe('topic continuity', () => {
  it('multiple messages in same direction use same topic', () => {
    const responderEphemeral = nacl.box.keyPair();
    const initiatorEphemeral = nacl.box.keyPair();
    const signingKeyPair = nacl.sign.keyPair();

    let session = initSessionAsInitiator({
      myAddress: '0xAlice',
      contactAddress: '0xBob',
      myHandshakeEphemeralSecret: initiatorEphemeral.secretKey,
      theirResponderEphemeralPubKey: responderEphemeral.publicKey,
      topicOutbound: '0x' + '1'.repeat(64) as `0x${string}`,
      topicInbound: '0x' + '2'.repeat(64) as `0x${string}`,
    });

    const topics: string[] = [];

    // Send multiple messages without receiving any
    for (let i = 0; i < 5; i++) {
      const result = ratchetEncrypt(session, new TextEncoder().encode(`msg${i}`), signingKeyPair.secretKey);
      topics.push(result.topic);
      session = result.session;
    }

    // All messages should use the same topic (no DH ratchet without receiving)
    expect(new Set(topics).size).toBe(1);
    expect(session.topicEpoch).toBe(0); // Still epoch 0
  });
});