---
sidebar_position: 1
title: How It Works
---

# How It Works

Verbeth is an end-to-end encrypted messaging protocol that uses Ethereum as its sole transport layer.

## Blockchain as Transport

Instead of running servers or relay infrastructure, Verbeth stores encrypted messages directly in Ethereum event logs. The blockchain provides:

- **Immutability**: Messages cannot be altered or deleted
- **Availability**: No server downtime, no message loss
- **Censorship resistance**: Anyone can read/write to the contract
- **Global ordering**: Block timestamps provide message ordering

Messages are emitted as events from the Verbeth contract. Clients query these events using standard RPC calls.

## No Servers, No Relays

Traditional encrypted messaging requires:

1. A server to store messages until recipients come online
2. Push infrastructure for notifications
3. Trust that the server doesn't log metadata

Verbeth eliminates all of this. The Ethereum network stores messages indefinitely. Recipients query the blockchain when they come online. The trust model shifts from "trust our servers" to "verify the chain."

## Identity Model

Your Ethereum address is your identity. No usernames, no phone numbers, no email verification.

Verbeth derives cryptographic keys from a single wallet signature:

```
Wallet Signature
      ↓
   HKDF Chain
      ↓
┌─────────────────────────────────────┐
│  X25519 (encryption)                │
│  Ed25519 (signing)                  │
│  secp256k1 session key (optional)   │
└─────────────────────────────────────┘
```

A binding proof cryptographically ties these derived keys to your Ethereum address. This proof is verified on-chain or via ERC-1271/ERC-6492 for smart accounts.

## Why Safe Accounts?

Verbeth works with EOAs but is optimized for Safe accounts:

- **Session keys**: Derived secp256k1 key can be authorized via Safe module, enabling messaging without repeated wallet signatures
- **Gasless messaging**: Paymasters can sponsor message transactions
- **Multi-sig recovery**: Safe's recovery mechanisms protect your messaging identity
- **ERC-1271 verification**: Smart contract signature verification built into the protocol

## Protocol Stack

```
┌─────────────────────────────────────┐
│           Application               │
├─────────────────────────────────────┤
│         VerbethClient               │
│   (sessions, encryption, keys)      │
├─────────────────────────────────────┤
│          @verbeth/sdk               │
│  (ratchet, handshake, identity)     │
├─────────────────────────────────────┤
│       VerbethV1 Contract           │
│  (Handshake, HandshakeResponse,     │
│   MessageSent events)               │
├─────────────────────────────────────┤
│           Ethereum                  │
│      (event logs, finality)         │
└─────────────────────────────────────┘
```

## On-Chain Data Model

The Verbeth contract emits three event types:

| Event | Purpose | Indexed Fields |
|-------|---------|----------------|
| `Handshake` | Initiate key exchange | `recipientHash`, `sender` |
| `HandshakeResponse` | Accept key exchange | `inResponseTo` |
| `MessageSent` | Encrypted message | `sender`, `topic` |

Topics are derived from shared secrets. Only participants know which topics belong to their conversation.

## Message Flow

1. **Alice initiates**: Emits `Handshake` with her ephemeral keys and identity proof
2. **Bob responds**: Emits `HandshakeResponse` with his keys, encrypted to Alice
3. **Both derive topics**: Shared secrets produce topic hashes for the conversation
4. **Messages flow**: Each party emits `MessageSent` to their outbound topic
5. **Topics evolve**: Double Ratchet advances topics for forward secrecy

See [Handshake](./handshake.md) and [Ratchet](./ratchet.md) for protocol details.
