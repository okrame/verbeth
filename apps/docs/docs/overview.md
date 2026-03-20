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

Most encrypted messaging systems solve the "cryptography problem" well, but what they leave intact is the trust problem. This can be declined as a server storing your messages, a company controlling the keys to that server and/or a jurisdiction controlling the company. In other words, we know that even unbreakable encryption can be switched off if someone can shut down the server it runs on.

To nail down the point one can read the [Trustless Manifesto](https://trustlessness.eth.limo/general/2025/11/11/the-trustless-manifesto.html) framing

> "The only defense is trustless design: systems whose correctness and fairness depend only on math and consensus, never on the goodwill of intermediaries."

So, what if clients query event logs from a single immutable contract?

Of course, average users still depend on RPC providers to read the chain, and on bundlers or paymasters if using account abstraction for gas sponsorship. The protocol itself, however, only requires that *some* path to Ethereum exists, and any provider is replaceable by another. A curious RPC provider or indexer that observes who fetches which events is currently a concern, though importantly, metadata privacy is still preserved from external observers on-chain (see [Metadata Privacy](concepts/security/metadata-privacy.md)). The practical answer for the retrieval layer today is running your own blockchain node, and we're actively working on private retrieval techniques that would make even that unnecessary.

## The walk-away test

Vitalik Buterin proposed a simple litmus test for decentralized systems:

> "If your team and servers disappeared tomorrow, would your application still be usable?"

Verbeth is designed toward passing this test. The reader of these docs can decide herself if this in fact the case.

> To get all the nice [cryptographic guarantees](concepts/security/cryptographic-guarantees.md), ratchet sessions, pending messages, and contact metadata live in app-managed storage via [`SessionStore`](how-it-works/wire-format.md) and [`PendingStore`](how-it-works/wire-format.md) interfaces that each application implements. If an app disappears without exporting that state, the on-chain ciphertext is preserved but users lose the keys to decrypt it. This is because the protocol does not prescribe where you store your state, only that you must store it. 

A companion question matters just as much: "If the original team wanted to interfere, could they stop the system from working or selectively prevent people from using it?"   
Again, the answer is left to the readers. Suffice to say that Verbeth bets everything on [full-stack openness](https://vitalik.eth.limo/general/2025/09/24/openness_and_verifiability.html).

## Own your messages

Shane Mac, co-founder of XMTP Labs, put it well:

> "Private servers require 'trust me', but having no private server means 'you don't have to trust me.'"
>
> — [Privacy Trends for 2026, a16z crypto](https://a16zcrypto.com/posts/article/privacy-trends-moats-quantum-data-testing/)

In Verbeth, messages live on a public blockchain, forever encrypted, so they are not hosted for you by a service that can revoke access. They are yours in the same way your ETH is yours.

An application built on Verbeth might store decrypted messages locally, back up encrypted session state to IPFS, or sync across devices via a user-controlled cloud. The protocol doesn't mandate a storage backend, so if one client shuts down, another can pick up where it left off, provided the user has their session state.



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


