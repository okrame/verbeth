---
sidebar_position: 2
title: Topic Ratcheting
---

# Topic Ratcheting

Topics are like the on-chain addresses of a given conversation. Every `MessageSent` event is indexed by a `topic` field, and this is how clients find messages meant for them. Topics are derived from shared secrets, so only participants know which topics belong to their conversation.

The reason for this is that verbeth cares about forward secrecy of metadata, not just content. Each DH ratchet step produces new topics, breaking the link between conversation epochs:

```
Epoch 0 (Handshake)                        Epoch 1 (Alice ratchets)                      Epoch 2 (Bob ratchets)
────────────────────────────────────────      ────────────────────────────────────────      ──────────────────────
topicOut_A = H(rk_0, dh_0, "outbound")        topicOut_A = H(rk_1, dh_1, "outbound")        topicOut_A = H(rk_2, dh_2, "outbound")
topicIn_A  = H(rk_0, dh_0, "inbound")         topicIn_A  = H(rk_1, dh_1, "inbound")         topicIn_A  = H(rk_2, dh_2, "inbound")
                   ↑                                                ↑                                                ↑
                unlinkable                                       unlinkable                                       unlinkable
```

>An observer watching the blockchain sees messages appear on different topics over time with no way to connect them across epochs. Within a single epoch, consecutive messages from the same party share the same topic, but this reveals nothing beyond the fact that the same party sent multiple messages in the same conversation, which is already implied by the topic existing at all.

## How topics derive

Each DH ratchet step feeds the new DH output and current root key into a topic derivation function:

```
rootKey (PQ-secure salt) + dhOutput
        |
        v
   HKDF(dhOutput, rootKey, "verbeth:topic-{direction}", 32)
        |
        v
   keccak256 → topic (bytes32)
```

The root key acts as HKDF salt. Because the root key descends from the [Handshake](../handshake.md)'s hybrid secret (X25519 + ML-KEM), topic derivation is quantum-resistant, meaning that even if X25519 is broken, topics from different epochs cannot be linked without the root key.

Direction is either `outbound` or `inbound`, so each party sends and listens on different topics. See [Ratcheting](../../how-it-works/ratcheting.md) for the exact KDF code.

## Grace period

When Alice performs a DH ratchet step, her outbound topic changes immediately. But Bob may have sent a message a few seconds earlier, on the old topic, and it's still sitting unconfirmed in the mempool. If Alice discarded the old inbound topic right away, she'd never see it.

To handle this, the SDK retains the previous inbound topic after a topic transition. In practice, the previous topic stays active until the next ratchet step overwrites it — the recorded `TOPIC_TRANSITION_WINDOW_MS` (300 000 ms) is stored but not currently enforced as an expiry. This means the old topic may remain valid longer than strictly necessary, which is a conservative trade-off: no legitimate messages are lost, at the cost of a slightly wider listening window.


## Next steps

- [Double Ratchet](./double-ratchet.md) -- the algorithm that drives topic evolution
- [Ratcheting](../../how-it-works/ratcheting.md) -- KDF code and full session state
- [Metadata Privacy](../security/metadata-privacy.md) -- threat analysis including metadata privacy
