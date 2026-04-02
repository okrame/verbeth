---
sidebar_position: 1
title: Protocol Flow
---

# Protocol Flow

This page walks through the full handshake exchange and the post-handshake messaging lifecycle, including how topics evolve across ratchet epochs. 

## Handshake sequence

The [handshake](../concepts/handshake.md) turns two strangers into a pair sharing a post-quantum root key. Everything happens through two on-chain events.

```
Alice (Initiator)                                    Bob (Responder)
─────────────────                                    ───────────────

1. Generate ephemeral X25519 keypair (a, A)
2. Generate ML-KEM-768 keypair (kemPk, kemSk)
3. Create identity binding proof (ECDSA)

        ──────────── Handshake event ────────────►
        │ recipientHash: keccak256("contact:" + bob) 
        │ pubKeys: [0x01 ‖ X25519_id ‖ Ed25519_id]    
        │ ephemeralPubKey: [A ‖ kemPk]  (1216 bytes)   
        │ plaintextPayload: { plaintextPayload, identityProof }
        └─────────────────────────────────────────

                                          4. Generate tag keypair (r, R)
                                          5. Generate ratchet keypair (rk_s, rk_p)
                                          6. ECDH: x_ss = DH(r, A)
                                          7. KEM encapsulate: (ct, kem_ss) = Encap(kemPk)
                                          8. Compute hybrid tag from x_ss and kem_ss
                                          9. Encrypt response payload to A using rk_s

        ◄────────── HandshakeResponse event ──────────
        │ inResponseTo: hybrid_tag                      
        │ responderEphemeralR: R  (tag pubkey, not rk_p)
        │ ciphertext: NaCl.box(response, A, rk_s)       
        └─────────────────────────────────────────────

10. Decrypt response, extract rk_p and ct
11. ECDH: x_ss = DH(a, R)
12. KEM decapsulate: kem_ss = Decap(ct, kemSk)
13. Verify hybrid tag matches inResponseTo
14. Derive hybrid root key from x_ss ‖ kem_ss

        ═══════════ Channel established ═══════════
```

### Two keypairs in the response

The responder generates two separate X25519 keypairs. The tag keypair `(r, R)` is used only for the hybrid tag computation. `R` goes on-chain as `responderEphemeralR`. The ratchet keypair `(rk_s, rk_p)` goes inside the encrypted payload and becomes the first DH key in the double ratchet session.

This separation matters because without it, the on-chain `R` would equal the first message's DH header key, allowing an observer to link the `HandshakeResponse` to the subsequent conversation.

>**Hybrid tag computation**:
The `inResponseTo` tag combines both classical and post-quantum shared secrets so that neither a classical nor a quantum adversary can link the response to its handshake. The computation in `crypto.ts` works as follows.

```
ecdhShared  = X25519(r, A)
okm         = HKDF-SHA256(ikm=kemSecret, salt=ecdhShared, info="verbeth:hsr-hybrid:v1", len=32)
tag         = keccak256(okm)
```

The initiator repeats this with their own private key `a` and the on-chain `R` to verify the match. Without both secrets, the tag is computationally indistinguishable from random. See [Metadata Privacy](../concepts/security/metadata-privacy.md#handshake-response-unlinkability) for the full threat analysis.


### Root key derivation

Once both parties hold the X25519 shared secret and the ML-KEM shared secret, they combine them into a single hybrid root key (see `ratchet/kdf.ts`).

```
combined    = x25519Secret ‖ kemSecret
hybridRoot  = HKDF-SHA256(ikm=combined, salt=zeros(32), info="VerbethHybrid", len=32)
```

All subsequent ratchet keys descend from this root. Because it incorporates ML-KEM, the entire session is post-quantum secure from message zero. See [Ratcheting](./ratcheting.md) for the formal derivation chain.

## Session bootstrapping

The initiator and responder initialize their ratchet sessions differently (see `ratchet/session.ts`).

**Responder (Bob)** computes `DH(rk_s, A)` and derives `(RK_0, CK_0_send)` from the hybrid root key. Bob can send immediately but has no receiving chain yet. That gets established when Alice's first message arrives carrying a new DH public key.

**Initiator (Alice)** derives the same `(RK_0, CK_0)` that Bob did, then immediately performs one DH ratchet step. Alice generates a fresh keypair, computes `DH(sk_1, rk_p)`, and derives `(RK_1, CK_1_send)`. She sets `CK_0` as her receiving chain key so she can decrypt Bob's messages right away. Alice also pre-computes epoch 1 topics at this point (see `session.ts`), so she already knows where to listen before any message is sent.

## Post-handshake messaging and topic lifecycle

After the handshake, messages flow through ratchet topics. Topics are bytes32 values derived from the root key and DH output at each ratchet step, and they serve as the on-chain address of the conversation (see [Topic Ratcheting](../concepts/ratchet/topic-ratcheting.md) for the rationale).

The topic lifecycle is more nuanced than "topics change at every DH ratchet step." It involves pre-computation, promotion, grace windows, and convergence.

```
Epoch 0 (handshake)              Epoch 1 (Alice sends)            Epoch 2 (Bob sends)
───────────────────              ─────────────────────            ────────────────────

Alice inits session:             Alice's first message:           Bob receives, ratchets:
 currentTopic = epoch0           emitted on epoch0 topic          sees new DH key from Alice
 nextTopic = epoch1 (precomp)    (outbound not yet promoted)      computes epoch2 topics
                                                                  promotes epoch1 → current
Bob inits session:               Bob receives:                    retains epoch1 as previous
 currentTopic = epoch0           message arrives on epoch0        (5 min grace window)
 nextTopic = none                or possibly on pre-computed
                                 nextTopic if timing overlaps
```

>The diagram above shows the typical flow where Alice sends first, but this ordering is not required as shown [here](./ratcheting.md#initiator-vs-responder-asymmetry).

### How topic transitions work

1. **Pre-computation.** When the initiator bootstraps, epoch 1 topics are already computed and stored as `nextTopicOutbound` / `nextTopicInbound` (see `session.ts`). During a DH ratchet step, the same happens for the next epoch (see `decrypt.ts`).

2. **Promotion.** When a message arrives on `nextTopicInbound`, the `SessionManager` promotes it to `currentTopicInbound`. The old current topic moves to `previousTopicInbound`. See `SessionManager.ts`.

3. **Grace window.** The previous inbound topic is retained with a `TOPIC_TRANSITION_WINDOW_MS` (5 minutes) expiry timestamp. This handles messages that were sent before the ratchet step but are still in the mempool or delayed by block reordering.

4. **Convergence.** When the next DH ratchet step occurs, `previousTopicInbound` is overwritten with whatever was current at that point. The old previous topic is discarded. So at most three inbound topics are active at any time (current, next, previous).

This is important for blockchain delivery because messages can arrive out of order across block boundaries. The combination of pre-computed next topics, a grace window for old topics, and the skip key mechanism (see [Ratcheting](./ratcheting.md)) ensures no legitimate messages are lost during topic transitions.

### Message flow within an epoch

Within a single DH epoch, all messages from the same sender share the same topic. The symmetric chain ratchet advances the chain key for each message, producing a unique message key every time. The on-chain event carries the sender address, topic, and the encrypted binary payload described in [Wire Formats](./wire-formats.md).

```
sender: 0xAlice
topic:  epoch1_outbound
payload: [version ‖ Ed25519_sig ‖ header{dh, pn, n} ‖ ciphertext]
```

The recipient finds the message by filtering for their active inbound topics, verifies the Ed25519 signature over header and ciphertext, then feeds the header into the ratchet for decryption. If the header carries a new DH public key, a DH ratchet step is triggered, which advances the epoch and derives new topics.
