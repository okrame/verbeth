---
sidebar_position: 0
slug: /
title: Overview
---

# Verbeth, what is it?

Verbeth is an end-to-end encrypted messaging protocol that uses a public EVM chain as its sole transport layer. 
This is an unusual property for a messaging protocol, as messages move through the chain itself, not through servers or relay infrastructure.

The premise is simple. If messaging infrastructure depends on someone’s goodwill to keep running, it will eventually be compromised, shut down, or degraded. Verbeth is designed to remove that dependency within the trust assumptions of the blockchain, while accepting the tradeoffs and implementation constraints that come with that choice.

---

## Why it exists

Most encrypted messaging systems solve the "cryptography problem" well. What they leave intact is the *trust* problem: a server stores your messages, a company controls the keys to that server, and a jurisdiction controls the company. Even unbreakable encryption can be switched off if someone can shut down the server it runs on.

To nail down the point one can read the [Trustless Manifesto](https://trustlessness.eth.limo/general/2025/11/11/the-trustless-manifesto.html) framing

> "The only defense is trustless design: systems whose correctness and fairness depend only on math and consensus, never on the goodwill of intermediaries."

So, what if clients query event logs from a single immutable contract?

Of course, average users still depend on RPC providers to read the chain, and on bundlers or paymasters if using account abstraction for gas sponsorship. The protocol itself, however, owns none of that infrastructure and it only requires that *some* path to Ethereum exists, and any provider is replaceable by another (see [metadata privacy](./concepts/security/metadata-privacy.md) for the RPC-level privacy implications).

## The walk-away test

Vitalik Buterin proposed a simple litmus test for decentralized systems:

> "If your team and servers disappeared tomorrow, would your application still be usable?"

Verbeth is designed toward passing this test. The reader of these docs can decide herself if this truly the case.

> To get all the nice [cryptographic guarantees](concepts/security/cryptographic-guarantees.md), ratchet sessions, pending messages, and contact metadata live in app-managed storage via [`SessionStore`](how-it-works/wire-format.md) and [`PendingStore`](how-it-works/wire-format.md) interfaces that each application implements. If an app disappears without exporting that state, the on-chain ciphertext is preserved but users lose the keys to decrypt it. This is an explicit design choice: the protocol does not prescribe *where* you store your state, only that you must store it. 

A companion question matters just as much. If the original team wanted to interfere, could they stop the system from working or selectively prevent people from using it?  
The answer is left to the reader here too. 

## Own your messages

Shane Mac, co-founder of XMTP Labs, put it well:

> "Private servers require 'trust me' — but having no private server means 'you don't have to trust me.'"
>
> — [Privacy Trends for 2026, a16z crypto](https://a16zcrypto.com/posts/article/privacy-trends-moats-quantum-data-testing/)

Verbeth takes this further: your messages live on a public blockchain, encrypted, forever. They are not hosted *for* you by a service that can revoke access. They are *yours* in the same way your ETH is yours — anyone can verify they exist, but only you hold the keys.

This means persistence is an app-level decision, not a protocol-level lock-in. An application built on Verbeth might store decrypted messages locally, back up encrypted session state to IPFS, or sync across devices via a user-controlled cloud. The protocol doesn't mandate a storage backend — it ensures that *no single app is the gatekeeper*. If one client shuts down, another can pick up where it left off, provided the user has their session state.

Vitalik's case for [full-stack openness](https://vitalik.eth.limo/general/2025/09/24/openness_and_verifiability.html) reinforces this: genuine openness means equality of access, verifiability, and no vendor lock-in. In Verbeth, every layer is inspectable — from the Solidity contract to the TypeScript SDK to the on-chain ciphertext itself.

## What Verbeth does NOT do

- **Deniability** — on-chain transactions are permanent and attributable. There is no way to deny having sent a message. This is a feature for some use cases and a limitation for others (see [Threat Model](./concepts/security/threat-model.md#non-repudiation)).
- **Metadata privacy from RPC providers** — without self-hosting or future private retrieval techniques, query patterns are visible to your RPC provider (see [Metadata Privacy](./concepts/security/metadata-privacy.md)).
- **Active quantum post-compromise security** — an adversary with both a quantum computer *and* device access can track keys through classical DH ratchet steps (see [Cryptographic Guarantees](./concepts/security/cryptographic-guarantees.md#against-quantum-adversary)).
- **Spam filtering** — Ethereum's gas model provides economic resistance, but the protocol does not filter content.

## Protocol stack

```
┌─────────────────────────────────────┐
│           Application               │
│    (UI, storage, notifications)     │
├─────────────────────────────────────┤
│         VerbethClient               │
│   (sessions, encryption, keys)      │
├─────────────────────────────────────┤
│          @verbeth/sdk               │
│  (ratchet, handshake, identity)     │
├─────────────────────────────────────┤
│       VerbethV1 Contract            │
│    (on-chain event emission)        │
├─────────────────────────────────────┤
│           Ethereum                  │
│      (event logs, finality)         │
└─────────────────────────────────────┘
```

**Application** — your client. Manages UI, message display, and local persistence via `SessionStore` / `PendingStore`.

**VerbethClient** — the high-level SDK entry point. Orchestrates handshakes, encrypts and decrypts messages, manages ratchet state. Works with EOAs directly and supports [Safe accounts](https://safe.global) for session keys, gas sponsorship, and multi-sig recovery via `SafeSessionSigner`.

**@verbeth/sdk** — core cryptographic modules: [identity binding](./concepts/identity.md), [hybrid handshake](./concepts/handshake.md) (X25519 + ML-KEM-768), and the [Double Ratchet](./concepts/ratchet/double-ratchet.md) with [topic ratcheting](./concepts/ratchet/topic-ratcheting.md).

**VerbethV1 Contract** — a single immutable contract on Base that emits `Handshake`, `HandshakeResponse`, and `MessageSent` events. Nothing more.

**Ethereum** — the transport and persistence layer. Event logs are immutable, globally available, and censorship-resistant.

## When to use Verbeth

**When non-repudiation matters**: audit trails, regulated workflows, legal agreements, on-chain governance, or any context where *who said what, and when* must be publicly and permanently verifiable — and where that is a feature, not a liability.

**When you need messaging without trust assumptions**: coordination between DAOs, cross-org communication, whistleblowing channels where the medium itself must be beyond any party's control.

**When durability matters more than ephemerality**: Verbeth messages cannot be deleted. For contexts where the permanent record is the point — compliance, dispute resolution, public accountability — this is by design. For contexts that need deniability, look elsewhere (Signal, for instance).

For protocol details, see the [Handshake](./concepts/handshake.md) and [Double Ratchet](./concepts/ratchet/double-ratchet.md) concepts, or the [Protocol Flow](./how-it-works/protocol-flow.md) for the full on-chain sequence.
