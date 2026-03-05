---
sidebar_position: 2
title: Identity
---

# Identity

In decentralized systems, identity is not as straightforward as it may seem. On blockchains, users are represented by addresses, but messaging protocols rely on encryption and signing keys that may exist indipendently.  

Verbeth binds cryptographic messaging keys to Ethereum addresses. A single wallet signature produces all keys, and a signed proof ties them to your address.

There are two distinct signing mechanisms in Verbeth:

| | Identity Proof | Message Signature |
|---|---|---|
| **Algorithm** | ECDSA (wallet) | Ed25519 (derived key) |
| **When** | Once, during setup | Every message |
| **Purpose** | Prove key ownership | Authenticate messages |
| **Verifier** | Anyone (on-chain compatible) | Conversation partner |

## Why Not Just Use the Transaction Signature?

Every EVM transaction is already signed. Couldn't that be enough? Not really, because the tx signature only proves that *some address* sent data to the contract. It says nothing about the encryption keys inside the payload. In fact, an attacker could submit a handshake containing someone else's public keys and the victim's messages would be readable by the attacker.

The **identity proof** is a wallet signature that says "I own these specific encryption and signing keys." so that recipients can check it before trusting any keys.

The **Ed25519 message signature** solves a different problem. Once a channel is established, messages flow through ratchet topics. Without per-message signatures, anyone who discovers a topic hash could inject fake messages. The Ed25519 signature on every message lets the recipient verify it actually came from the person they handshaked with, without needing the blockchain to confirm anything.

## Key Derivation

A single wallet signature seeds the entire key hierarchy:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Seed message: "Verbeth Identity Seed v1 / Address: 0x... / Context: ... │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
                            Wallet signs
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  IKM = HKDF-SHA256(                                                      │
│    input: canonicalize(sig) ‖ SHA256(message) ‖ "verbeth/addr:" ‖ addr   │
│    salt:  "verbeth/seed-sig-v1"                                          │
│    info:  "verbeth/ikm"                                                  │
│  )                                                                       │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
                ┌─────────────────┼─────────────────┐
                │                 │                 │
                ▼                 ▼                 ▼
        ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
        │   X25519     │  │   Ed25519    │  │   secp256k1      │
        │  encryption  │  │   signing    │  │  session key *   │
        │              │  │              │  │                  │
        │ "verbeth-    │  │ "verbeth-    │  │ "verbeth-session-│
        │  x25519-v1"  │  │  ed25519-v1" │  │  secp256k1-v1"   │
        └──────────────┘  └──────────────┘  └──────────────────┘

 * The session key is always derived but only used by apps that delegate
   transactions to a Safe module (e.g. gasless messaging).
```

Properties:
- **Deterministic**: same signature always produces the same keys
- **Reproducible**: user can regenerate keys by re-signing
- **Isolated**: different addresses produce unrelated keys
- **Memory-safe**: all intermediate material is wiped after derivation

### Unified Key Format

Public keys are encoded as a 65-byte blob for on-chain use:

```
Byte 0       Bytes 1-32        Bytes 33-64
┌──────┬──────────────────┬──────────────────┐
│ 0x01 │  X25519 (32)     │  Ed25519 (32)    │
└──────┴──────────────────┴──────────────────┘
```

This format is used in handshake events so that recipients can extract both keys from a single field.

## Identity Proof

The identity proof is an ECDSA signature that binds your derived keys to your Ethereum address. It's created once and included in every handshake you send.

### Binding Message

```
VerbEth Key Binding v1
Address: 0xabc...
PkEd25519: 0x123...
PkX25519: 0x456...
ExecutorAddress: 0xdef...
ChainId: 8453
RpId: my-app
```

| Field | Purpose |
|-------|---------|
| `Address` | Signer's EVM address (EOA) |
| `PkEd25519` | Ed25519 public key (signing) |
| `PkX25519` | X25519 public key (encryption) |
| `ExecutorAddress` | Address that sends transactions (Safe or EOA) |
| `ChainId` | Chain ID (to prevent cross-chain replay) |
| `RpId` | Application identifier (optional, prevents cross-app replay) |

### What It Proves

The identity proof establishes this chain of trust:

```
Ethereum Address
       │
  ECDSA signature of binding message
       │
  "I control 0xabc... and I authorize
   these X25519/Ed25519 keys"
       │
  ┌────┴─────┐
  X25519     Ed25519
  (encrypt)  (sign)
```

Anyone who receives a handshake can verify:
1. The wallet owner authorized these specific public keys
2. The keys are bound to a specific chain and executor
3. The proof hasn't been replayed from another chain or app

### Verification

Since the identity proof is just a standard signed message, Verbeth can verify it against many types of EVM account: plain EOAs via `ecrecover`, deployed smart accounts via ERC-1271, and even counterfactual accounts via ERC-6492.

## Message Signatures (Ed25519)

After the handshake, every ratchet message carries an Ed25519 *detached* signature. This is separate from the identity proof and it uses the Ed25519 key that was authorized during identity setup.


### What Gets Signed

Each message signature covers the header + ciphertext as a single blob:

```
Signed data = header (40 bytes) ‖ ciphertext (variable)

Header layout:
┌──────────────────┬──────────┬──────────┐
│ DH ratchet key   │    pn    │    n     │
│    (32 bytes)    │ (4B, BE) │ (4B, BE) │
└──────────────────┴──────────┴──────────┘

signature = Ed25519.sign_detached(header ‖ ciphertext, ed25519_secret_key)
→ 64 bytes, detached
```

- **DH ratchet key**: the sender's current ratchet public key
- **pn**: message count in the previous sending epoch
- **n**: message number in the current epoch
- **ciphertext**: nonce (24 bytes) + XSalsa20-Poly1305 output

The recipient independently reconstructs the signed blob from the header and ciphertext, then verifies.

See [Wire Format](../how-it-works/wire-format.md) for the full binary layout and verification order.
