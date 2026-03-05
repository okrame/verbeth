---
sidebar_position: 2
title: Protocol Flow
---

# Protocol Flow

This page details the full handshake exchange — the sequence of on-chain events, cryptographic operations, and key derivations that establish an encrypted channel. For the conceptual overview, see [Handshake](../concepts/handshake.md).

## Handshake Sequence

```
Alice (Initiator)                              Bob (Responder)
─────────────────                              ───────────────

1. Generate ephemeral X25519 keypair (a, A)
2. Generate ML-KEM-768 keypair (kemPk, kemSk)
3. Create identity proof

        ─────── Handshake Event ───────►
        │ recipientHash: H(bob_addr)    │
        │ ephemeralPubKey: A            │
        │ kemPublicKey: kemPk           │
        │ identityProof: {...}          │
        └───────────────────────────────┘

                                        4. Generate ephemeral keypair (r, R)
                                        5. Compute X25519: x_ss = ECDH(r, A)
                                        6. Encapsulate KEM: (ct, kem_ss) = Encap(kemPk)
                                        7. Compute hybrid tag:
                                           tag = HKDF(x_ss || kem_ss, "verbeth:hsr-hybrid:v1")
                                        8. Encrypt response to A

        ◄───── HandshakeResponse ──────
        │ inResponseTo: tag             │
        │ responderEphemeralR: R        │
        │ ciphertext: Enc(A, response)  │
        └───────────────────────────────┘

9. Decrypt response, extract R, ct
10. Compute X25519: x_ss = ECDH(a, R)
11. Decapsulate KEM: kem_ss = Decap(ct, kemSk)
12. Verify tag matches
13. Derive root key from hybrid secret

        ═══════ Channel Established ═══════
```

## Hybrid Tag Computation

The `inResponseTo` tag links a response to its handshake using the hybrid secret. This prevents on-chain observers from correlating the two events:

```typescript
function computeHybridTag(
  ecdhSecret: Uint8Array,  // X25519 shared secret
  kemSecret: Uint8Array    // ML-KEM shared secret
): `0x${string}` {
  const okm = hkdf(sha256, kemSecret, ecdhSecret, "verbeth:hsr-hybrid:v1", 32);
  return keccak256(okm);
}
```

Observers cannot link `HandshakeResponse` to its `Handshake` without the shared secrets. See [Security Model](../concepts/security.md#handshake-response-unlinkability) for detailed analysis against classical and quantum adversaries.

## Root Key Derivation

The initial root key for the [Double Ratchet](../concepts/ratchet/double-ratchet.md) combines both secrets:

```typescript
function hybridInitialSecret(
  x25519Secret: Uint8Array,
  kemSecret: Uint8Array
): Uint8Array {
  const combined = concat([x25519Secret, kemSecret]);
  return hkdf(sha256, combined, zeros(32), "VerbethHybrid", 32);
}
```

This root key is post-quantum secure. All subsequent ratchet keys derive from it, propagating PQ security through the entire conversation.

## On-Chain Events

### Handshake Event

```solidity
event Handshake(
  bytes32 indexed recipientHash,
  address indexed sender,
  bytes ephemeralPubKey,    // 32 bytes X25519
  bytes kemPublicKey,       // 1184 bytes ML-KEM-768
  bytes plaintextPayload    // Identity proof + note
);
```

### HandshakeResponse Event

```solidity
event HandshakeResponse(
  bytes32 indexed inResponseTo,  // Hybrid tag
  address indexed responder,
  bytes responderEphemeralR,     // 32 bytes X25519
  bytes ciphertext               // Encrypted response (includes KEM ciphertext)
);
```

## Gas Considerations

| Component | Size | Notes |
|-----------|------|-------|
| X25519 ephemeral | 32 bytes | Minimal |
| ML-KEM public key | 1184 bytes | Dominates handshake cost |
| ML-KEM ciphertext | 1088 bytes | In encrypted response |
| Identity proof | ~500 bytes | Signature + message |

Handshake initiation costs more due to the KEM public key. The response is encrypted, so the KEM ciphertext is hidden in the blob.

## Executor Abstraction

Handshake transactions can be sent via:

- **EOA**: Direct wallet transaction
- **Safe Module**: Session key authorized by Safe

The identity proof's `ExecutorAddress` field specifies which address will send the transaction, enabling verification regardless of executor type.
