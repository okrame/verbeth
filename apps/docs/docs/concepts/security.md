---
sidebar_position: 5
title: Security Model
---

# Security Model

This document describes Verbeth's threat model, security guarantees, and tradeoffs compared to traditional encrypted messaging.

## Threat Classes

Verbeth considers three distinct adversary types:

### 1. Passive Network Observer

**Who**: Block explorers, chain indexers, MEV searchers

**Capabilities**:
- Read all on-chain data (events, calldata)
- Correlate transactions by address
- Build transaction graphs

**Cannot**:
- Read message contents (encrypted)
- Link topics to recipients (hash-based)
- Determine conversation participants from topics alone

### 2. Active RPC Adversary

**Who**: Your RPC provider (Infura, Alchemy, self-hosted)

**Capabilities**:
- See all queries you make
- Observe which topics you subscribe to
- Correlate query timing with message receipt

**Cannot**:
- Decrypt message contents
- Forge messages (no private keys)

**Critical**: RPC providers can perform correlation attacks linking senders to receivers by observing query patterns. See [Metadata Privacy](#metadata-privacy).

### 3. State Compromise Adversary

**Who**: Malware, device theft, insider threat

**Capabilities**:
- Read session state (root keys, chain keys)
- Decrypt future messages until ratchet step
- Potentially impersonate user

**Mitigated by**:
- Forward secrecy (past messages protected)
- Post-compromise security (future messages protected after DH ratchet)

## Authentication & Non-Repudiation

### msg.sender as Authentication

Ethereum's transaction model provides protocol-level sender authentication:

- `msg.sender` is the transaction signer
- Cannot be forged without private key
- Verified by every node in the network

### Binding Proofs

Identity proofs add application-level authentication:

- Signed message ties keys to Ethereum address
- Verified by recipient before decryption
- Supports EOA, ERC-1271, and ERC-6492

### Non-Repudiation

**Verbeth provides non-repudiation by design.** This is a fundamental difference from Signal:

| | Verbeth | Signal |
|---|---------|--------|
| **Message attribution** | Permanent, on-chain | Deniable |
| **Third-party verification** | Anyone can verify sender | Cannot prove authorship |
| **Legal admissibility** | Strong (blockchain evidence) | Weak (cryptographic deniability) |

**On-chain transactions are permanent, attributable records.** A message sender cannot later deny sending a message. The blockchain provides:

- Immutable record of who sent what
- Timestamp from block inclusion
- Cryptographic proof via transaction signature

**Signal's deniability** works because messages are authenticated with ephemeral keys that both parties know. Either party could have forged the message. Verbeth explicitly trades deniability for trustless, verifiable communication.

**Use cases where non-repudiation matters**:
- Business communications requiring audit trails
- Legal agreements and contracts
- Compliance-regulated messaging

## Forward Secrecy

**Definition**: Compromise of current keys does not reveal past messages.

### Mechanism

1. Each DH ratchet step derives new keys
2. Old keys are deleted after derivation
3. Even with current state, past messages cannot be decrypted

### Unconditional from Message 0

Unlike some protocols that require multiple messages before FS kicks in, Verbeth provides forward secrecy immediately:

- Handshake uses ephemeral keys only
- No long-term keys in key exchange
- First message is already protected

### Key Deletion Importance

Forward secrecy only works if old keys are actually deleted:

```typescript
// SDK wipes keys after use
try {
  messageKey.fill(0);
  chainKey.fill(0);
} catch {}
```

Application developers must ensure session state isn't backed up in ways that preserve old keys.

## Post-Compromise Security

**Definition**: Security recovery after state compromise.

### Against Classical Adversary

**Full PCS**: After a DH ratchet step, security is restored.

```
Compromise here
      ↓
[msg 1] [msg 2] [msg 3] [DH ratchet] [msg 4] [msg 5]
  ✗       ✗       ✗         │          ✓       ✓
                            └── Security restored
```

The attacker can read messages until the next DH exchange. After that, they're locked out.

### Against Quantum Adversary

Two scenarios to consider:

**Passive quantum (HNDL)**:
- Adversary records ciphertext now, decrypts later with quantum computer
- **Fully protected**: Root key is PQ-secure from ML-KEM
- All messages inherit this protection

**Active quantum + state compromise**:
- Adversary has quantum computer AND compromises device state
- **PCS degraded**: Subsequent DH ratchets use X25519 (quantum-vulnerable)
- Attacker can compute future DH shared secrets

This is an honest limitation. Full PQ PCS would require hybrid KEM ratcheting (future work).

## Post-Quantum Security

### HNDL Resistance

"Harvest Now, Decrypt Later" attacks are mitigated:

1. **Handshake**: ML-KEM-768 protects initial key exchange
2. **Root key derivation**: Hybrid secret (X25519 + ML-KEM)
3. **Key propagation**: All chain keys derive from PQ-secure root
4. **Result**: All messages protected, not just handshake

### Why Hybrid (X25519 + ML-KEM)

Defense-in-depth principle:

| Threat | X25519 | ML-KEM | Hybrid |
|--------|--------|--------|--------|
| Classical attack | Secure | Secure | Secure |
| Quantum attack (Shor) | Broken | Secure | Secure |
| Cryptanalytic breakthrough | Secure | ? | Secure |

ML-KEM is NIST-standardized but newer. X25519 is battle-tested. Combining them ensures security if either remains secure.

### Limitations

Honest assessment of what's NOT quantum-secure:

- **DH ratchet steps**: Use X25519 only (practical tradeoff)
- **Active quantum + state compromise**: No full PCS
- **Topic derivation**: Uses DH output (though salted with PQ-secure root)

## Metadata Privacy

### On-Chain Visibility

Observers see:

| Visible | Hidden |
|---------|--------|
| Sender addresses | Recipient identity |
| Topic hashes | Topic-to-recipient mapping |
| Ciphertext blobs | Message content |
| Transaction timing | Conversation relationships |
| Gas costs | |

### Handshake-Response Unlinkability

The `Handshake` and `HandshakeResponse` events have no plaintext link. The only connection is the `inResponseTo` tag, which requires shared secrets to compute:

```
tag = keccak256(HKDF(kemSecret, ecdhSecret, "verbeth:hsr-hybrid:v1"))
```

**Against passive classical adversary**:
- Observer sees Alice's ephemeral public key in `Handshake`
- Observer sees `inResponseTo` tag in `HandshakeResponse`
- Cannot compute tag without Bob's ephemeral secret (never published)

**Against passive quantum adversary**:
- Quantum computer could solve ECDH from public keys (Shor's algorithm)
- But tag derivation also requires `kemSecret` from ML-KEM
- ML-KEM ciphertext is inside the encrypted response payload
- Cannot decrypt payload without Alice's ephemeral secret
- Result: still cannot link handshake to response

### Handshake-to-Message Unlinkability

After handshake, messages use topics derived from the hybrid root key:

```
rootKey = HKDF(x25519Secret || kemSecret, "VerbethHybrid")
topic = keccak256(HKDF(dhOutput, rootKey, "verbeth:topic"))
```

**Against passive classical adversary**:
- Topics are hashes with no reversible link to handshake public keys
- Cannot determine which `Handshake` led to which `MessageSent` topic

**Against passive quantum adversary**:
- Even with ECDH broken, `rootKey` includes `kemSecret`
- Topics inherit PQ security from root key salt
- Cannot link handshake ephemeral keys to message topics

### The RPC Problem

**Critical trust boundary**: Your RPC provider sees your queries.

When you query for messages:
```typescript
// RPC sees this query
contract.queryFilter("MessageSent", { topic: myTopic })
```

The RPC can:
1. Note which topics you query
2. Correlate with message emission timing
3. Link sender address to querying address

**Mitigations**:
- Self-hosted node (eliminates RPC trust)
- Tor/VPN (hides query origin)
- Decoy queries (noise injection)
- Query aggregation services (future)

## Replay & DoS Protection

### Ethereum's Gas Model

Spam resistance through economics:
- Every message costs gas
- Attack cost scales linearly
- No free amplification attacks

### Ed25519 Signature Verification

Before any ratchet state changes:

```typescript
// O(1) verification, O(n) ratchet ops
if (!nacl.sign.detached.verify(data, sig, pubKey)) {
  return null; // Reject immediately
}
```

Invalid signatures are rejected before expensive key derivation.

### Nonce Tracking (Optional)

For applications requiring strict deduplication:
- Track message hashes or (topic, n) pairs
- Reject duplicates at application layer
- SDK provides hooks for custom logic

## Comparison with Signal Protocol

| Property | Verbeth | Signal |
|----------|---------|--------|
| **Transport** | Blockchain (public, immutable) | Server relay (private, ephemeral) |
| **Authentication** | `msg.sender` + binding proof | X3DH with identity keys |
| **Non-repudiation** | Yes (on-chain attribution) | No (deniable) |
| **Prekey infrastructure** | None | Required (server-hosted) |
| **Forward secrecy** | From message 0 | From message 0 |
| **PCS (classical)** | Full | Full |
| **PCS (quantum)** | Degraded (active + compromise) | Degraded (same) |
| **HNDL resistance** | Yes (ML-KEM-768 hybrid) | Yes (PQXDH) |
| **Offline delivery** | Yes (blockchain stores forever) | Yes (server queues) |
| **Metadata privacy** | RPC trust required | Server trust required |

### Verbeth Advantages

- **No server infrastructure**: Eliminates server trust entirely
- **Trustless delivery**: Blockchain finality guarantees delivery
- **Smart account integration**: Session keys, gasless messaging
- **Audit trail**: Compliance-friendly immutable records
- **Censorship resistance**: Permissionless access

### Verbeth Tradeoffs

- **No deniability**: On-chain = permanent attribution
- **Higher latency**: Block times (2s L2, 12s L1)
- **Gas costs**: Each message costs money
- **RPC metadata**: Query patterns visible to provider
- **Larger handshakes**: ML-KEM public keys are 1184 bytes

## Summary

Verbeth provides strong security guarantees with explicit tradeoffs:

| Guarantee | Status |
|-----------|--------|
| End-to-end encryption | Yes |
| Forward secrecy | Yes, from message 0 |
| Post-compromise security (classical) | Yes |
| HNDL resistance | Yes |
| Sender authentication | Yes, protocol-level |
| Recipient privacy | Yes, from chain observers |
| Deniability | No (explicit design choice) |
| Metadata privacy from RPC | No (requires self-hosting) |
| Full PQ PCS | No (active quantum + compromise) |
