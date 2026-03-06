---
sidebar_position: 1
title: Double Ratchet
---

# Double Ratchet

Verbeth uses the Double Ratchet algorithm for all post-handshake encryption. It provides forward secrecy (past messages stay safe if keys leak) and post-compromise security (future messages recover after a compromise). The design follows the [Signal Double Ratchet specification](https://signal.org/docs/specifications/doubleratchet/) with adaptations for blockchain transport.

## Two ratchets, one goal

The algorithm combines two ratcheting mechanisms:

```
                    Root Key (PQ-secure)
                        |
        ┌───────────────┼───────────────┐
        |               |               |
        v               v               v
    DH Step 0       DH Step 1       DH Step 2        <-- DH ratchet (per round-trip)
        |               |               |
        v               v               v
    ┌────────┐      ┌────────┐      ┌────────┐
    | CK 0   |      | CK 0   |      | CK 0   |
    |  → MK₀ |      |  → MK₀ |      |  → MK₀ |      <-- Symmetric chain ratchet
    |  → MK₁ |      |  → MK₁ |      |  → MK₁ |          (per message)
    |  → MK₂ |      |  → ... |      |  → ... |
    └────────┘      └────────┘      └────────┘
```

**DH ratchet** advances every round-trip (when you receive a message with a new DH key). Each step produces a fresh chain key via a new Diffie-Hellman exchange. This gives per-round-trip forward secrecy: old DH keys are deleted, making past chains unrecoverable.

**Symmetric chain ratchet** advances every message within a DH epoch. Each chain key derives a unique message key, then is replaced. Even within the same epoch, each message gets its own key.

## Forward secrecy and post-compromise security

**Forward secrecy**: Every DH ratchet step deletes old keys. If an attacker compromises your current state, they cannot decrypt messages from previous DH epochs.

**Post-compromise security**: A single round-trip introduces fresh DH randomness, re-establishing a secure channel even after a full state compromise.

Because the root key originates from the [Handshake](../handshake.md)'s hybrid key exchange, all derived keys inherit post-quantum security.

## Session state

Each ratchet session tracks:

| Field | Purpose |
|-------|---------|
| `rootKey` | Current root key (32 bytes, PQ-secure) |
| `dhMySecretKey` / `dhMyPublicKey` | My current DH keypair |
| `dhTheirPublicKey` | Their last DH public key |
| `sendingChainKey` / `receivingChainKey` | Current symmetric chain keys |
| `sendingMsgNumber` / `receivingMsgNumber` | Message counters (N, Nr) |
| `previousChainLength` | Messages in previous sending chain (PN header) |
| `skippedKeys` | Stored keys for out-of-order messages |
| Topic fields | Current, next, and previous topics per direction |

**Session state must be persisted after every encrypt/decrypt operation.** Rolling back to stale state creates duplicate message keys and breaks security guarantees. See [Ratchet Internals](../../how-it-works/ratchet-internals.md) for the full TypeScript interface.

### Duplicate message replay

Message keys are single-use. When a message is successfully decrypted, its key is immediately deleted from the skipped-keys store, or the receiving chain advances past it. If an attacker re-broadcasts the same ciphertext, no matching key exists and decryption fails. This guarantee depends on persisting session state after every decrypt.

## Out-of-order messages

Blockchain delivery doesn't guarantee order. When message N arrives but we expected message M (where M < N), the ratchet pre-derives and stores the skipped keys for messages M through N-1.

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_SKIP_PER_MESSAGE` | 100,000 | Reject messages requiring excessive skips |
| `MAX_STORED_SKIPPED_KEYS` | 1,000 | Prune oldest when exceeded |
| `MAX_SKIPPED_KEYS_AGE_MS` | 24 hours | TTL for stored skip keys |

So, these bounds prevent DoS via malicious skip counts while tolerating real-world blockchain reordering.

## Next steps

- [Topic Ratcheting](./topic-ratcheting.md) -- how conversation topics evolve for metadata privacy
- [Ratchet Internals](../../how-it-works/ratchet-internals.md) -- KDFs, code, full session state
- [Wire Format](../../how-it-works/wire-format.md) -- binary layout of ratchet messages
