---
sidebar_position: 3
title: Metadata Privacy
---

# Metadata Privacy

Verbeth encrypts message content, but it runs on a public blockchain, so the question is always: what *metadata* leaks? 

## What can anybody see?

| Visible | Hidden |
|---------|--------|
| Sender addresses | Recipient identity |
| Topic hashes | Topic-to-recipient mapping |
| Ciphertext blobs | Message content |
| Transaction timing | Conversation relationships |
| Gas costs | |

An observer can see that an address sent an encrypted payload to a topic, but cannot determine who reads that topic or what the payload says. Since the sender addresses themselves are pseudonymous, an on-chain address is not an identity unless it has been linked to one externally (e.g. via ENS, exchange deposits, or public association). The metadata privacy guarantees below build on top of this baseline pseudonymity.

## Handshake-Response Unlinkability

Let's say 0x123 emits a `Handshake` whose `recipientHash` is `hash(0x789)`, and 0x789 emits a `HandshakeResponse`. An observer cannot link them, because the `inResponseTo` tag in 0x789's response is derived from shared secrets that require private key material to compute. The only possible way to link these two events is if only these two accounts are using the protocol.

**Against classical adversary**: The tag is a hash of a value derived from an X25519 shared secret and an ML-KEM shared secret. The observer sees 0x123's ephemeral public key in the `Handshake` and the tag in the `HandshakeResponse`, but cannot compute the X25519 shared secret without 0x789's ephemeral private key.

**Against a quantum adversary**: A quantum computer could solve the X25519 DH from the public keys. But the tag derivation *also* requires the ML-KEM shared secret. The ML-KEM ciphertext is inside the encrypted response payload which cannot be decrypted without 0x123's ephemeral secret. So even a quantum adversary cannot link the handshake to its response.

For the exact tag computation, see [Protocol Flow](../../how-it-works/protocol-flow.md#two-keypairs-in-the-response).

## Handshake-to-Message Unlinkability

After the handshake, messages use topics derived from the hybrid root key via HKDF and keccak256. These topics are hashes with no reversible link to the handshake's public keys.

**Against a classical adversary**: topics cannot be traced back to the `Handshake` event that established the session.

**Against a quantum adversary**: even with X25519 broken, the root key includes the ML-KEM shared secret. Topics inherit this PQ protection because the root key acts as the HKDF salt in topic derivation.

For the full derivation, see [how topics derive](../ratchet/topic-ratcheting.md#how-topics-derive).

## Message-to-Message Unlinkability

Within a single DH epoch, consecutive messages from the same party share the same topic. An observer can tell that "the same sender sent multiple messages in the same epoch" but this is inherent to the topic existing at all.

**Across epochs**, topics change and are unlinkable. Each DH ratchet step feeds fresh randomness into topic derivation, producing a completely new topic with no observable relationship to the previous one.  
See [Topic Ratcheting](../ratchet/topic-ratcheting.md#grace-period) for details.

## The RPC Problem

When you query for messages, the RPC sees which topics you subscribe to, when you poll, and can correlate your queries with message emission timing. All this can potentially link sender addresses to recipient addresses.

**Side mitigations**:
- **Self-hosted node**: eliminates RPC trust entirely
- **Tor / VPN**: hides the query origin (IP address)
- **Decoy queries**: noise injection to obscure real interest patterns
- **Query aggregation**: batching queries across multiple topics to reduce per-topic signal

A future integration of will allow clients to query an untrusted indexer without revealing which topics or recipients they are interested in. The indexer sees only opaque, homomorphically encrypted queries, making topic-level correlation infeasible even for a fully malicious provider.

## Ciphertext Length Analysis

On-chain ciphertext lengths are visible to everyone. Without mitigation, message length alone can reveal information (e.g. distinguishing a "yes" from a paragraph). See [here](../../how-it-works/ratcheting.md#ciphertext-padding) how Verbeth pads all plaintext into fixed-size buckets before encryption. 