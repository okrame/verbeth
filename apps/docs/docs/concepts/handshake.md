---
sidebar_position: 3
title: Handshake
---

# Handshake

Verbeth uses a hybrid key exchange to establish encrypted channels between two EVM addresses. The handshake is how two on-chain parties go from "strangers" to "sharing a secret" with no server infrastructure.

## What it Accomplishes

A successful handshake produces a **shared root key** that both parties can use to initialize a [Double Ratchet](./ratchet.md) session. This root key is derived from two independent key exchanges performed simultaneously:

1. **X25519**: classical elliptic-curve Diffie-Hellman
2. **ML-KEM-768**: NIST-standardized post-quantum KEM (formerly Kyber)
 
Verbeth uses ephemeral-only DH paired with ML-KEM so that no long-term keys participate in the key exchange. Authentication is separated entirely: `msg.sender` is a guarantee from Ethereum, and a cryptographic [binding proof](./identity.md) ties the EVM address to the long-term keys. 

## Why hybrid?

Defense-in-depth against an uncertain cryptographic future:

- If X25519 is broken (e.g. quantum computers running Shor's algorithm), ML-KEM still protects the root key
- If ML-KEM is broken (future cryptanalysis of lattice problems), X25519 still protects the root key

So, security holds as long as either primitive remains secure.

This is especially important for "Harvest Now, Decrypt Later" attacks, i.e. adversaries who record encrypted blockchain traffic today, hoping to decrypt it with future quantum computers. Because Verbeth's [root key](./ratchet.md#root-key-derivation)  depends on ML-KEM, even a future quantum adversary cannot recover past session keys. For a detailed security analysis, see [Security Model](./security.md#handshake-response-unlinkability).

### Other PQ-secure handshake protocols

| | **Verbeth** | **Signal** | **XMTP** |
|---|---|---|---|
| **Transport** | Blockchain events | Server-relayed | XMTP network nodes |
| **Server trust** | None | Prekey server | Node operators |
| **Offline initiation** | Not yet<sup>1</sup> | Yes (prekeys) | Yes (KeyPackages) |
| **Authentication** | On-chain `msg.sender`+ Identity proof | Identity keys mixed into DH | Installation keys + wallet signature |
| **Key exchange** | 1 KEM + 1 eph. DH | 1 KEM + up to 4 DH | MLS TreeKEM |
| **Post-quantum** | Yes (hybrid, mandatory) | Yes (hybrid, mandatory) | Yes (hybrid, optional) |
| **Forward secrecy** | Unconditional<sup>2</sup> | Conditional on IK + SPK security | Conditional on leaf node security |

For a deeper analysis of how PQ security propagates through each protocol's key schedule, see [Post-Quantum Comparison](./security.md#post-quantum-comparison-verbeth-vs-signal-vs-xmtp). For the full security comparison (forward secrecy, post-compromise security, metadata privacy), see [Security Model](./security.md).

---

<sup>1</sup> A planned **Contact KEM** integration will allow recipients to publish ML-KEM keys on-chain, enabling hybrid-encrypted first-message payloads. Under the hood the 2-step handshake flow remains unchanged, but first contact will be protected, hence simulating an offline initiation.

<sup>2</sup> Only ephemeral keys participate in key derivation: `SK = KDF(DH(EKa, EKb) || KEM_SS)`. Even if all long-term keys are later compromised, past sessions are unrecoverable because both ephemeral secrets were deleted after use. (Differently, in Signal, if both Bob's identity key and signed prekey are compromised, all sessions established under that prekey are recoverable, and althogh this is mitigated via prekey rotation, there is always an active window.)



## Next Steps

- [Protocol Flow](../how-it-works/protocol-flow.md) — the full step-by-step exchange, on-chain events, and code
- [Double Ratchet](./ratchet.md) — what happens after the handshake
- [Wire Format](../how-it-works/wire-format.md) — how messages are encoded on-chain
