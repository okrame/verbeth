---
sidebar_position: 2
title: Ratcheting
---

# Ratcheting

This page covers the encryption and decryption flows in detail, the formal key derivation math, and the bootstrapping process that makes the entire chain post-quantum secure. For forward secrecy and post-compromise security, see this [conceptual overview](../concepts/ratchet/double-ratchet.md).

## Encrypt flow

```
prepareMessage(conversationId, plaintext)
        │
        ▼
  Load RatchetSession from store
        │
        ▼
  sendingChainKey exists?
  ┌─────┴──────┐
  NO           YES
  │             │
  error         ▼
            kdfChainKey(CK)
            ├── messageKey = HMAC-SHA256(CK, 0x01)
            └── newChainKey = HMAC-SHA256(CK, 0x02)
                    │
                    ▼
            Pad plaintext (bucket scheme)
                    │
                    ▼
            XSalsa20-Poly1305 encrypt with messageKey
            (24-byte random nonce prepended)
                    │
                    ▼
            Build header { dh: myDHPublicKey, pn, n }
                    │
                    ▼
            Ed25519.sign(header ‖ ciphertext, signingSecretKey)
                    │
                    ▼
            Package binary payload (see Wire Formats)
                    │
                    ▼
            Persist updated session immediately
            (forward secrecy: key is gone)
                    │
                    ▼
            Return PreparedMessage
```

Session state is committed before the transaction is submitted. If the transaction fails, the ratchet slot is "burned" and the receiver handles the gap through skip keys. See [VerbethClient](./verbeth-client.md) for the two-phase commit pattern.

## Decrypt flow

```
decryptMessage(topic, payload, senderSigningKey)
        │
        ▼
  Find session by inbound topic
  (current → next → previous)
        │
        ▼
  Parse binary payload
  ├── signature  = bytes[1..65]
  ├── header     = bytes[65..105]
  └── ciphertext = bytes[105..]
        │
        ▼
  Ed25519.verify(signature, header ‖ ciphertext, senderSigningKey)
        │
   ┌────┴────┐
  FAIL      PASS
   │         │
  drop       ▼
  silently   Check skipped keys for (dhPubHex, n)
             ┌────┴────┐
           FOUND      NOT FOUND
             │           │
          decrypt        ▼
          with it      header.dh ≠ dhTheirPublicKey?
                       ┌────┴────┐
                      YES        NO
                       │          │
                       ▼          ▼
                  DH ratchet    Skip forward if n > Nr
                  step           │
                       │         ▼
                       ▼     kdfChainKey → messageKey
                  kdfChainKey → messageKey
                       │
                       ▼
                  XSalsa20-Poly1305 decrypt
                       │
                       ▼
                  Unpad plaintext
                       │
                       ▼
                  Persist updated session
```

Signature verification happens first, before any ratchet state is touched. This is O(1) and rejects invalid or malicious messages without risking state corruption.


## Formal key derivation

### DH ratchet step

```
(RK_i+1, CK_i+1)  ←  HKDF-SHA256( ikm = dh_i+1,  salt = RK_i )
```

where `dh_i+1 = X25519(sk_new, pk_their)` is the new DH shared secret. The HKDF info string is `"VerbethRatchet"` and the output length is 64 bytes, split into a 32-byte root key and a 32-byte chain key (see `ratchet/kdf.ts`).

### Symmetric ratchet step

```
MK_i    =  HMAC-SHA256(CK_i, 0x01)
CK_i+1  =  HMAC-SHA256(CK_i, 0x02)
```

`MK_i` is the per-message encryption key fed into XSalsa20-Poly1305. `CK_i+1` replaces `CK_i` and is used for the next message in the same epoch.

### Bootstrapping from the hybrid shared secret

```
(RK_0, CK_0)  ←  HKDF-SHA256( ikm = ss_hyb,  salt = 0  [no prior RK] )
```

The initial root key and chain key are derived from the hybrid shared secret (in `hybridInitialSecret()`) with a zero salt (no prior root key exists). The hybrid secret itself combines both key exchange outputs:

```
ss_hyb  =  HKDF-SHA256( ikm = X25519_ss ‖ KEM_ss,  salt = 0_32,  info = "VerbethHybrid" )
```

### Initiator vs responder asymmetry

The **responder** (Bob) derives `(RK_0, CK_0_send)` directly from the bootstrapping step. Bob can send messages right away using `CK_0_send`, but has no receiving chain key yet.

The **initiator** (Alice) derives the same `(RK_0, CK_0)`, then immediately performs one DH ratchet step with a fresh keypair.

```
dh_1  =  X25519(sk_1, pk_Bob)

(RK_1, CK_1_send)  ←  HKDF-SHA256( ikm = dh_1,  salt = RK_0 )
```

Alice sets `CK_0` as her receiving chain key (matching Bob's sending chain), and uses `CK_1_send` for her own messages. She also pre-computes epoch 1 topics from `RK_1` and `dh_1` at this point (see `ratchet/session.ts`).

When Bob receives Alice's first message, he sees a new DH public key in the header, triggers his own DH ratchet step, and the protocol enters steady-state alternation.

## Skip key management

Blockchain delivery does not guarantee message ordering. When a message with number `n` arrives but the receiver expected `m` (where `m < n`), the ratchet pre-derives and stores message keys for positions `m` through `n-1`.

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_SKIP_PER_MESSAGE` | 100,000 | Reject messages requesting excessive skips |
| `MAX_STORED_SKIPPED_KEYS` | 1,000 | Prune oldest entries when storage exceeds this |
| `MAX_SKIPPED_KEYS_AGE_MS` | 24 hours | TTL for stored skip keys |

Each stored skip key records the DH epoch identifier (hex of their public key), message number, derived message key, and creation timestamp. Expired-key pruning is not performed inline during `skipMessages()` but it is a separate helper (`pruneExpiredSkippedKeys()`) that applications call at their discretion (e.g. applying it on session load). If the total exceeds 1,000 after pruning, the oldest entries are dropped (see `ratchet/decrypt.ts`).

Message keys are single-use. After successful decryption, the key is removed from the store (or the chain has advanced past it). Replaying the same ciphertext fails because no matching key exists. This guarantee depends on persisting session state after every decrypt.

## Ciphertext padding

Before encryption, plaintext is padded into fixed-size buckets to reduce metadata leakage from on-chain ciphertext lengths. The scheme in `ratchet/padding.ts` works as follows.

The plaintext is framed with a 1-byte marker (`0x00`) and a 4-byte big-endian length prefix, then placed into a bucket. Bucket selection uses power-of-2 sizes from a minimum of 64 bytes up to 16,384 bytes. Above that threshold, buckets grow in linear steps of 4,096 bytes. On top of the bucket size, a random jitter of up to `bucket / 8` bytes is added.

The padding bytes are filled with `nacl.randomBytes`, making them indistinguishable from ciphertext after encryption. An observer sees the total encrypted blob size, which reveals at most O(log n) bits about the plaintext length within the exponential range.
