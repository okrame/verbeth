---
sidebar_position: 4
title: Double Ratchet
---

# Double Ratchet

Verbeth uses the Double Ratchet algorithm for post-handshake encryption, providing forward secrecy and post-compromise security.

## Overview

The Double Ratchet combines two ratchets:

1. **DH Ratchet**: New Diffie-Hellman exchange on each round-trip
2. **Symmetric Ratchet**: Key derivation for each message

```
                Root Key
                   │
    ┌──────────────┼──────────────┐
    │              │              │
    ▼              ▼              ▼
  DH Step 1     DH Step 2     DH Step 3
    │              │              │
    ▼              ▼              ▼
┌───────┐      ┌───────┐      ┌───────┐
│Chain 1│      │Chain 2│      │Chain 3│
│ Key 0 │      │ Key 0 │      │ Key 0 │
│ Key 1 │      │ Key 1 │      │ Key 1 │
│ Key 2 │      │  ...  │      │  ...  │
└───────┘      └───────┘      └───────┘
```

## Key Derivation Functions

### Root Key Derivation

When a DH ratchet step occurs:

```typescript
function kdfRootKey(rootKey: Uint8Array, dhOutput: Uint8Array) {
  const output = hkdf(sha256, dhOutput, rootKey, "VerbethRatchet", 64);
  return {
    rootKey: output.slice(0, 32),   // New root key
    chainKey: output.slice(32, 64)  // New chain key
  };
}
```

### Chain Key Derivation

For each message in a chain:

```typescript
function kdfChainKey(chainKey: Uint8Array) {
  return {
    messageKey: hmac(sha256, chainKey, [0x01]),  // Encrypt this message
    chainKey: hmac(sha256, chainKey, [0x02])     // Next chain key
  };
}
```

## Session State

The `RatchetSession` contains:

```typescript
interface RatchetSession {
  // Identity
  conversationId: string;       // keccak256(sort([topicOut, topicIn]))
  myAddress: string;
  contactAddress: string;

  // Root Ratchet
  rootKey: Uint8Array;          // 32 bytes, PQ-secure from handshake

  // DH Ratchet Keys
  dhMySecretKey: Uint8Array;    // My current DH secret
  dhMyPublicKey: Uint8Array;    // My current DH public (in message headers)
  dhTheirPublicKey: Uint8Array; // Their last DH public

  // Sending Chain
  sendingChainKey: Uint8Array | null;
  sendingMsgNumber: number;     // Ns

  // Receiving Chain
  receivingChainKey: Uint8Array | null;
  receivingMsgNumber: number;   // Nr

  // Skip Handling
  previousChainLength: number;  // PN header field
  skippedKeys: SkippedKey[];    // For out-of-order messages

  // Topic Ratcheting
  currentTopicOutbound: `0x${string}`;
  currentTopicInbound: `0x${string}`;
  topicEpoch: number;
}
```

**Critical**: Session state must be persisted after every encrypt/decrypt operation. Failure to persist creates security vulnerabilities and message loss.

## Topic Ratcheting

Topics evolve with the DH ratchet to maintain forward secrecy of conversation metadata:

```typescript
function deriveTopic(
  rootKey: Uint8Array,    // PQ-secure salt
  dhOutput: Uint8Array,   // DH shared secret
  direction: 'outbound' | 'inbound'
): `0x${string}` {
  const info = `verbeth:topic-${direction}:v3`;
  const okm = hkdf(sha256, dhOutput, rootKey, info, 32);
  return keccak256(okm);
}
```

The root key as HKDF salt provides quantum-resistant topic unlinkability. Even if X25519 is broken, topics from different epochs cannot be linked without the root key.

### Topic Evolution

```
Epoch 0 (Handshake)     Epoch 1 (Alice ratchets)    Epoch 2 (Bob ratchets)
─────────────────────   ────────────────────────    ──────────────────────
topicOutA = H(salt₀)    topicOutA = H(salt₁)        topicOutA = H(salt₂)
topicInA  = H(salt₀)    topicInA  = H(salt₁)        topicInA  = H(salt₂)
```

### Grace Period

When topics change, the previous inbound topic remains valid for 5 minutes (`TOPIC_TRANSITION_WINDOW_MS`). This handles:

- Messages in flight during ratchet
- Blockchain reorgs
- Out-of-order delivery

```typescript
interface RatchetSession {
  previousTopicInbound?: `0x${string}`;
  previousTopicExpiry?: number;  // Date.now() + 5 minutes
}
```

## Out-of-Order Messages

Blockchain delivery doesn't guarantee order. The ratchet handles this via skip keys:

### Skip Key Storage

When message N arrives but we expected message M (where M < N):

```typescript
// Store keys for messages M through N-1
for (let i = M; i < N; i++) {
  const { chainKey, messageKey } = kdfChainKey(currentChainKey);
  skippedKeys.push({
    dhPubKeyHex: hexlify(theirDHPub),
    msgNumber: i,
    messageKey: messageKey,
    createdAt: Date.now()
  });
  currentChainKey = chainKey;
}
```

### Bounds and Pruning

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_SKIP_PER_MESSAGE` | 100,000 | Reject messages requiring excessive skips |
| `MAX_STORED_SKIPPED_KEYS` | 1,000 | Prune oldest when exceeded |
| `MAX_SKIPPED_KEYS_AGE_MS` | 24 hours | TTL for skip keys |

## Burned Slots

**Rollback is forbidden**. If you decrypt a message, the session state advances. Re-using old state creates:

- Duplicate message keys (breaks confidentiality)
- Orphan skip keys for the receiver

Example of what NOT to do:

```typescript
// WRONG: Not persisting state
const result = ratchetDecrypt(session, header, ciphertext);
// forgot to save result.session
// next decrypt uses old session = security failure
```

## DoS Protection

Before ratchet operations, signatures are verified:

```typescript
// O(1) rejection of invalid messages
const headerBytes = encodeHeader(header);
const dataToVerify = concat([headerBytes, ciphertext]);
const valid = nacl.sign.detached.verify(dataToVerify, signature, signingPubKey);

if (!valid) {
  return null;  // Reject without touching ratchet state
}
```

Ed25519 verification is cheap. This prevents attackers from forcing expensive ratchet computations with invalid messages.

## Message Format

Binary payload structure:

```
┌─────────┬───────────┬────────────┬────────────┐
│ Version │ Signature │   Header   │ Ciphertext │
│ 1 byte  │ 64 bytes  │  40 bytes  │  variable  │
└─────────┴───────────┴────────────┴────────────┘

Header (40 bytes):
┌──────────────────┬──────────┬──────────┐
│    DH PubKey     │    PN    │    N     │
│     32 bytes     │  4 bytes │  4 bytes │
└──────────────────┴──────────┴──────────┘
```

- **DH PubKey**: Sender's current ratchet public key
- **PN**: Previous chain length (for skip key calculation)
- **N**: Message number in current chain

## Security Properties

| Property | Mechanism |
|----------|-----------|
| **Forward secrecy** | DH ratchet step deletes old keys |
| **Post-compromise security** | New DH exchange after compromise heals |
| **Out-of-order tolerance** | Skip keys with bounded storage |
| **DoS resistance** | Ed25519 verification before ratchet ops |
| **Topic unlinkability** | Root key salt for topic derivation |
