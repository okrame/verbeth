---
sidebar_position: 3
title: Ratchet Internals
---

# Ratchet Internals (WIP...)

Implementation details of the Double Ratchet. For the conceptual overview, see [Double Ratchet](../concepts/ratchet/double-ratchet.md).

## Session initialization

Initiator and responder initialize differently:

**Responder** (Bob): receives Alice's ephemeral DH public key from the `Handshake` event, computes the DH output, and derives the first receiving chain key. Bob's initial state has a `receivingChainKey` but no `sendingChainKey` -- that comes when Bob sends his first message and performs a DH ratchet step.

**Initiator** (Alice): receives Bob's ephemeral from the `HandshakeResponse`, computes the DH output, and derives the first sending chain key. Alice also pre-computes epoch 1 topics (the topics that will be active after Bob's first DH ratchet step), so she can listen on them immediately.

Both derive the root key from the hybrid secret: `hybridInitialSecret(x25519Secret, kemSecret)`. See [Protocol Flow](./protocol-flow.md) for the full handshake sequence.

## Key derivation functions

### Root key derivation

When a DH ratchet step occurs, the new DH output and current root key produce a fresh root key and chain key:

```typescript
function kdfRootKey(rootKey: Uint8Array, dhOutput: Uint8Array) {
  // HKDF-SHA256: dhOutput as IKM, rootKey as salt
  const output = hkdf(sha256, dhOutput, rootKey, 'VerbethRatchet', 64);
  return {
    rootKey: output.slice(0, 32),    // New root key
    chainKey: output.slice(32, 64),  // New chain key
  };
}
```

### Chain key derivation

For each message in a chain, HMAC-SHA256 derives a unique message key and advances the chain:

```typescript
function kdfChainKey(chainKey: Uint8Array) {
  return {
    messageKey: hmac(sha256, chainKey, [0x01]),  // Encrypt/decrypt this message
    chainKey: hmac(sha256, chainKey, [0x02]),     // Next chain key
  };
}
```

### Hybrid initial secret

Combines X25519 and ML-KEM shared secrets into the initial root key:

```typescript
function hybridInitialSecret(x25519Secret: Uint8Array, kemSecret: Uint8Array) {
  const combined = concat([x25519Secret, kemSecret]);
  return hkdf(sha256, combined, zeros(32), 'VerbethHybrid', 32);
}
```

### Topic derivation

Each DH ratchet step derives new topics using the root key as PQ-secure salt:

```typescript
function deriveTopic(
  rootKey: Uint8Array,
  dhOutput: Uint8Array,
  direction: 'outbound' | 'inbound'
): `0x${string}` {
  const info = `verbeth:topic-${direction}:v3`;
  const okm = hkdf(sha256, dhOutput, rootKey, info, 32);
  return keccak256(okm);
}
```

## Encrypt flow

1. If no `sendingChainKey` exists, perform a DH ratchet step: generate new DH keypair, compute DH output with their public key, derive new root key + sending chain key, derive new topics
2. Derive `messageKey` and advance `sendingChainKey` via `kdfChainKey`
3. Encrypt plaintext with `nacl.secretbox` using `messageKey`
4. Build header: `{ dh: myDHPublicKey, pn: previousChainLength, n: sendingMsgNumber }`
5. Sign `header || ciphertext` with Ed25519
6. Encode as binary payload (see [Wire Format](./wire-format.md))
7. Return updated session state -- **caller must persist it**

## Decrypt flow

1. Parse binary payload, extract version + signature + header + ciphertext
2. **Signature-first verification**: verify Ed25519 signature over `header || ciphertext` before any ratchet operations (DoS protection -- O(1) rejection of invalid messages)
3. Check skipped keys: if header's DH key + message number matches a stored skip key, decrypt with that key and remove it
4. If header's DH key differs from `dhTheirPublicKey`, perform a DH ratchet step: store skip keys for remaining messages in current receiving chain, compute new root key + receiving chain key from new DH output
5. Skip forward in current chain if `header.n > receivingMsgNumber`
6. Derive `messageKey` via `kdfChainKey`, decrypt ciphertext
7. Return updated session state -- **caller must persist it**

## DH ratchet step

When a new DH public key arrives in a message header:

1. Store skip keys for any unreceived messages in the current receiving chain (up to `MAX_SKIP_PER_MESSAGE`)
2. Compute `dhOutput = X25519(dhMySecretKey, newTheirPublicKey)`
3. `kdfRootKey(rootKey, dhOutput)` → new `rootKey` + `receivingChainKey`
4. Generate fresh DH keypair for sending
5. Compute `dhOutput = X25519(newMySecretKey, newTheirPublicKey)`
6. `kdfRootKey(rootKey, dhOutput)` → new `rootKey` + `sendingChainKey`
7. Derive new topics from step 5's DH output (outbound/inbound labels swap relative to the peer)
8. Set grace period on previous inbound topic (`TOPIC_TRANSITION_WINDOW_MS`)
9. Reset `sendingMsgNumber = 0`, `receivingMsgNumber = 0`, save `previousChainLength`

## Skip key management

Stored as an array of `SkippedKey` entries:

```typescript
interface SkippedKey {
  dhPubKeyHex: string;     // DH epoch identifier
  msgNumber: number;       // Message number in that epoch
  messageKey: Uint8Array;  // Derived message key (32 bytes)
  createdAt: number;       // Timestamp for TTL pruning
}
```

**Pruning strategy:**
- Before storing new skip keys, prune entries older than `MAX_SKIPPED_KEYS_AGE_MS` (24h)
- If storage exceeds `MAX_STORED_SKIPPED_KEYS` (1,000), drop the oldest entries
- A single message cannot request more than `MAX_SKIP_PER_MESSAGE` (100,000) skips

## DoS protection

Ratchet state is expensive to mutate (DH computations, chain key derivations). To prevent attackers from triggering these operations with invalid messages:

1. Ed25519 signature is verified **before** any ratchet processing
2. Verification is O(1) and cheap compared to ratchet operations
3. Invalid messages are rejected without touching session state

See [Wire Format](./wire-format.md) for the binary layout that enables signature-first parsing.

## Full session state

The complete `RatchetSession` interface from the SDK:

```typescript
interface RatchetSession {
  // Conversation Identity
  conversationId: string;                      // keccak256(sort([topicOut, topicIn]))
  topicOutbound: `0x${string}`;                // Original handshake-derived outbound topic
  topicInbound: `0x${string}`;                 // Original handshake-derived inbound topic
  myAddress: string;
  contactAddress: string;

  // Root Ratchet
  rootKey: Uint8Array;                         // 32 bytes, PQ-secure

  // DH Ratchet Keys
  dhMySecretKey: Uint8Array;                   // My current DH secret (32 bytes)
  dhMyPublicKey: Uint8Array;                   // My current DH public (32 bytes)
  dhTheirPublicKey: Uint8Array;                // Their last DH public (32 bytes)

  // Sending Chain
  sendingChainKey: Uint8Array | null;          // null until first DH ratchet as sender
  sendingMsgNumber: number;                    // Ns

  // Receiving Chain
  receivingChainKey: Uint8Array | null;        // null until first message received
  receivingMsgNumber: number;                  // Nr

  // Skip Handling
  previousChainLength: number;                 // PN header field
  skippedKeys: SkippedKey[];

  // Topic Ratcheting
  currentTopicOutbound: `0x${string}`;         // May differ from original after ratcheting
  currentTopicInbound: `0x${string}`;
  nextTopicOutbound?: `0x${string}`;           // Pre-computed for next DH step
  nextTopicInbound?: `0x${string}`;
  previousTopicInbound?: `0x${string}`;        // Grace period for late messages
  previousTopicExpiry?: number;                // Date.now() + TOPIC_TRANSITION_WINDOW_MS
  topicEpoch: number;

  // Metadata
  createdAt: number;
  updatedAt: number;
  epoch: number;                               // Increments on session reset
}
```
