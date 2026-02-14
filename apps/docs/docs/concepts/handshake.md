---
sidebar_position: 3
title: Handshake
---

# Handshake

Verbeth uses a hybrid key exchange combining X25519 (classical) and ML-KEM-768 (post-quantum) to establish encrypted channels.

## Overview

Unlike Signal's X3DH which uses prekeys stored on a server, Verbeth uses ephemeral-only key exchange:

| X3DH (Signal) | Verbeth |
|---------------|---------|
| Prekey server required | No server infrastructure |
| Offline initiation | Initiator must wait for response |
| Multiple DH operations | Ephemeral + KEM hybrid |

The tradeoff: Verbeth requires the responder to come online before the channel is established, but eliminates server trust entirely.

## Hybrid Key Exchange

Verbeth combines two key exchange mechanisms:

### X25519 (Classical)

- Well-understood elliptic curve Diffie-Hellman
- 128-bit security against classical computers
- Vulnerable to quantum computers running Shor's algorithm

### ML-KEM-768 (Post-Quantum)

- NIST-standardized lattice-based KEM (formerly Kyber)
- 192-bit security against quantum computers
- Larger keys (1184 bytes public, 1088 bytes ciphertext)

### Why Hybrid?

Defense-in-depth:

- If X25519 is broken (quantum), ML-KEM protects
- If ML-KEM is broken (cryptanalysis), X25519 protects
- Security holds if *either* primitive remains secure

This protects against "Harvest Now, Decrypt Later" (HNDL) attacks where adversaries record encrypted traffic today hoping to decrypt with future quantum computers.

## Protocol Flow

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

The `inResponseTo` tag links response to handshake using the hybrid secret:

```typescript
function computeHybridTag(
  ecdhSecret: Uint8Array,  // X25519 shared secret
  kemSecret: Uint8Array    // ML-KEM shared secret
): `0x${string}` {
  const okm = hkdf(sha256, kemSecret, ecdhSecret, "verbeth:hsr-hybrid:v1", 32);
  return keccak256(okm);
}
```

Observers cannot link `HandshakeResponse` to its `Handshake` without the shared secrets. See [Security Model](./security.md#handshake-response-unlinkability) for detailed analysis against classical and quantum adversaries.

## Root Key Derivation

The initial root key for the Double Ratchet combines both secrets:

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

Handshake initiation costs more due to the KEM public key. Response is encrypted, so KEM ciphertext is hidden in the blob.

## Executor Abstraction

Handshake transactions can be sent via:

- **EOA**: Direct wallet transaction
- **Safe Module**: Session key authorized by Safe

The identity proof's `ExecutorAddres` field specifies which address will send the transaction, enabling verification regardless of executor type.

## Security Properties

| Property | Guarantee |
|----------|-----------|
| **Forward secrecy** | Ephemeral keys provide FS from message 0 |
| **HNDL resistance** | ML-KEM protects root key against quantum |
| **Identity binding** | Proof ties keys to Ethereum address |
| **Quantum unlinkability** | Tag derivation hides handshake-response link |
