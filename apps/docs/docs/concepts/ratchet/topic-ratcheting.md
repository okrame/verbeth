---
sidebar_position: 2
title: Topic Ratcheting
---

# Topic Ratcheting

Topics are the on-chain addresses of a conversation. Every `MessageSent` event is indexed by a `topic` field, and this is how clients find messages meant for them. Topics are derived from shared secrets, so only participants know which topics belong to their conversation.

## Why topics ratchet

Forward secrecy of **metadata**, not just content. If an adversary learns an old topic, they can find old messages on-chain but cannot predict future topics. Each DH ratchet step produces new topics, breaking the link between conversation epochs.

```
Epoch 0 (Handshake)       Epoch 1 (Alice ratchets)     Epoch 2 (Bob ratchets)
───────────────────       ──────────────────────       ─────────────────────
topicOut_A = H(rk₀, dh₀)  topicOut_A = H(rk₁, dh₁)    topicOut_A = H(rk₂, dh₂)
topicIn_A  = H(rk₀, dh₀)  topicIn_A  = H(rk₁, dh₁)    topicIn_A  = H(rk₂, dh₂)
       ↑                          ↑                            ↑
   unlinkable                 unlinkable                   unlinkable
```

An observer watching the blockchain sees messages appear on different topics over time with no way to connect them.

## How topics derive

Each DH ratchet step feeds the new DH output and current root key into a topic derivation function:

```
rootKey (PQ-secure salt) + dhOutput
        |
        v
   HKDF(dhOutput, rootKey, "verbeth:topic-{direction}:v3", 32)
        |
        v
   keccak256 → topic (bytes32)
```

The root key acts as HKDF salt. Because the root key descends from the [Handshake](../handshake.md)'s hybrid secret (X25519 + ML-KEM), topic derivation is quantum-resistant: even if X25519 is broken, topics from different epochs cannot be linked without the root key.

Direction is either `outbound` or `inbound`, so each party sends and listens on different topics. See [Ratchet Internals](../../how-it-works/ratchet-internals.md#topic-derivation) for the exact KDF code.

## Grace period

When topics change, the previous inbound topic stays valid for **5 minutes** (`TOPIC_TRANSITION_WINDOW_MS = 300,000ms`).

```
        DH ratchet step
              |
              v
    new topics active
    ┌─────────────────────────────────────────┐
    | old inbound topic  ─── grace (5 min) ──►  expired |
    | new inbound topic  ─── active ──────────────────► |
    └─────────────────────────────────────────┘
```

This handles:

- **Messages in flight**: Sent before the sender knew topics changed
- **Blockchain reorgs**: Transaction ordering may shift
- **Out-of-order delivery**: Earlier messages arriving late

## Application flexibility

Topic ratcheting is transparent to applications. The SDK handles topic transitions internally -- apps just call `encrypt` and `decrypt`. This makes the protocol suitable for any use case: chat, notifications, IoT telemetry, or anything else that needs private on-chain messaging.

## Next steps

- [Double Ratchet](./double-ratchet.md) -- the algorithm that drives topic evolution
- [Ratchet Internals](../../how-it-works/ratchet-internals.md) -- KDF code and full session state
- [Security Model](../security.md) -- threat analysis including metadata privacy
