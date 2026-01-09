# Double Ratchet Flow: Alice ↔ Bob

## Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PROTOCOL PHASES                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  PHASE 1: Handshake (on-chain)     → Establish identity + ephemeral keys    │
│  PHASE 2: Session Init (local)     → Create RatchetSession from ephemerals  │
│  PHASE 3: Messaging (on-chain)     → Encrypt/decrypt with ratchet           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Handshake (Existing Flow)

```
    ALICE (Initiator)                                      BOB (Responder)
    ═════════════════                                      ═══════════════
           │                                                      │
           │  1. Generate ephemeral keypair                       │
           │     eA = (eA.secret, eA.public)                      │
           │                                                      │
           │  2. Create Handshake tx:                             │
           │     • recipientHash                                  │
           │     • pubKeys (identity X25519 + Ed25519)            │
           │     • ephemeralPubKey = eA.public        ─────────►  │
           │     • plaintextPayload + identityProof               │
           │                                                      │
           │  3. Store eA.secret locally                          │
           │     (needed to derive session later)                 │
           │                                                      │
           │                                               4. Verify handshake
           │                                                  (signature, proof)
           │                                                      │
           │                                               5. Generate ephemeral
           │                                                  eB = (eB.secret, eB.public)
           │                                                      │
           │                                               6. Create HandshakeResponse:
           │                                                  • inResponseTo (tag)
           │  ◄─────────────────────────────────────────────  • responderEphemeralR = eB.public
           │                                                  • encrypted payload
           │                                                      │
           │                                               7. ⚠️ STORE eB.secret
           │                                                  (becomes dhMySecretKey!)
           │                                                      │
    8. Verify response                                            │
       (decrypt, verify proof)                                    │
           │                                                      │
           │                                                      │
    ═══════╪══════════════════════════════════════════════════════╪═══════════
           │              HANDSHAKE COMPLETE                      │
           │         Both have: eA.public, eB.public              │
           │         Alice has: eA.secret                         │
           │         Bob has: eB.secret                           │
    ═══════╪══════════════════════════════════════════════════════╪═══════════
```

### On-Chain Data After Handshake

```
┌─────────────────────────────────────────────────────────────────┐
│ Handshake Event (from Alice's emitter)                          │
├─────────────────────────────────────────────────────────────────┤
│ • sender: Alice's Safe/EOA                                      │
│ • pubKeys: Alice's identity keys (X25519 + Ed25519)             │
│ • ephemeralPubKey: eA.public  ◄── Used for initial DH          │
│ • plaintextPayload: message + identity proof                    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ HandshakeResponse Event (from Bob's emitter)                    │
├─────────────────────────────────────────────────────────────────┤
│ • responder: Bob's Safe/EOA                                     │
│ • responderEphemeralR: eB.public  ◄── Bob's first DH key       │
│ • inResponseTo: tag (links to Alice's handshake)                │
│ • ciphertext: encrypted response                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 2 (local): Session Initialization

### Initial Shared Secret (Ephemeral-Only!)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ CRITICAL: NO IDENTITY KEYS IN DH                                            │
│                                                                             │
│ sharedSecret = DH(eA.secret, eB.public)  // Alice computes                  │
│              = DH(eB.secret, eA.public)  // Bob computes (same result)      │
│                                                                             │
│ WHY: Compromise of identity keys NEVER decrypts past messages               │
│      (not even message #0)                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Bob's Session Init (Responder - happens first)

```
    BOB (initSessionAsResponder)
    ════════════════════════════
    
    INPUT:
    ┌─────────────────────────────────────┐
    │ myResponderEphemeralSecret: eB.secret│
    │ myResponderEphemeralPublic: eB.public│
    │ theirHandshakeEphemeralPubKey: eA.public│
    │ topicOutbound, topicInbound         │
    └─────────────────────────────────────┘
    
    DERIVATION:
    
    sharedSecret = DH(eB.secret, eA.public)
                        │
                        ▼
    ┌─────────────────────────────────────┐
    │ KDF_RK(zeros, sharedSecret)         │
    │   → rootKey₀                        │
    │   → sendingChainKey₀                │
    └─────────────────────────────────────┘
    
    OUTPUT SESSION:
    ┌─────────────────────────────────────┐
    │ rootKey: rootKey₀                   │
    │ dhMySecretKey: eB.secret   ◄── REUSE│
    │ dhMyPublicKey: eB.public            │
    │ dhTheirPublicKey: eA.public         │
    │ sendingChainKey: sendingChainKey₀   │
    │ sendingMsgNumber: 0                 │
    │ receivingChainKey: null  ◄── Not yet│
    │ receivingMsgNumber: 0               │
    └─────────────────────────────────────┘
    
    Bob can SEND immediately, but cannot RECEIVE
    until Alice sends (with her new DH key)
```

### Alice's Session Init (Initiator - happens after receiving response)

```
    ALICE (initSessionAsInitiator)
    ══════════════════════════════
    
    INPUT:
    ┌─────────────────────────────────────┐
    │ myHandshakeEphemeralSecret: eA.secret│
    │ theirResponderEphemeralPubKey: eB.public│
    │ topicOutbound, topicInbound         │
    └─────────────────────────────────────┘
    
    DERIVATION:
    
    1. Same initial secret as Bob:
       sharedSecret = DH(eA.secret, eB.public)
                           │
                           ▼
       KDF_RK(zeros, sharedSecret) → rootKey₀, bobsSendingChain
    
    2. Generate NEW DH keypair for Alice:
       dh1 = generateDHKeyPair() → (dh1.secret, dh1.public)
    
    3. Perform sending ratchet step:
       dhSend = DH(dh1.secret, eB.public)
                      │
                      ▼
       KDF_RK(rootKey₀, dhSend) → rootKey₁, aliceSendingChain
    
    OUTPUT SESSION:
    ┌─────────────────────────────────────┐
    │ rootKey: rootKey₁                   │
    │ dhMySecretKey: dh1.secret  ◄── NEW  │
    │ dhMyPublicKey: dh1.public           │
    │ dhTheirPublicKey: eB.public         │
    │ sendingChainKey: aliceSendingChain  │
    │ sendingMsgNumber: 0                 │
    │ receivingChainKey: bobsSendingChain │◄── Can receive Bob's msgs!
    │ receivingMsgNumber: 0               │
    └─────────────────────────────────────┘
    
    Alice can SEND and RECEIVE immediately
```

### Session State After Init

```
    ┌──────────────────────────┐          ┌──────────────────────────┐
    │      ALICE SESSION       │          │       BOB SESSION        │
    ├──────────────────────────┤          ├──────────────────────────┤
    │ dhMyPub: dh1.public      │          │ dhMyPub: eB.public       │
    │ dhTheirPub: eB.public    │          │ dhTheirPub: eA.public    │
    │                          │          │                          │
    │ sendingChain: ✓          │          │ sendingChain: ✓          │
    │ receivingChain: ✓        │          │ receivingChain: null     │
    │                          │          │                          │
    │ Can send: YES            │          │ Can send: YES            │
    │ Can receive: YES         │          │ Can receive: NO*         │
    └──────────────────────────┘          └──────────────────────────┘
    
    * Bob's receivingChain is established when Alice sends her first message
      (which includes dh1.public in the header)
```

---

## Phase 3: Message Exchange

### Message Format (Binary)

```
┌─────────────────────────────────────────────────────────────────┐
│ Offset │ Size │ Field                                           │
├────────┼──────┼─────────────────────────────────────────────────┤
│ 0      │ 1    │ Version (0x01)                                  │
│ 1      │ 64   │ Ed25519 signature (over header + ciphertext)    │
│ 65     │ 32   │ DH ratchet public key (sender's current)        │
│ 97     │ 4    │ pn (previous chain length)                      │
│ 101    │ 4    │ n (message number in current chain)             │
│ 105    │ var  │ nonce (24) + secretbox ciphertext               │
└─────────────────────────────────────────────────────────────────┘
```

### Scenario 1: Alice Sends First Message

```
    ALICE                                                    BOB
    ═════                                                    ═══
       │                                                      │
       │  ratchetEncrypt(session, "Hello Bob!")               │
       │  ┌────────────────────────────────────┐              │
       │  │ 1. KDF_CK(sendingChainKey)         │              │
       │  │    → newChainKey, messageKey       │              │
       │  │                                    │              │
       │  │ 2. Header:                         │              │
       │  │    dh = dh1.public                 │              │
       │  │    pn = 0                          │              │
       │  │    n = 0                           │              │
       │  │                                    │              │
       │  │ 3. Encrypt with messageKey         │              │
       │  │ 4. Sign(header || ciphertext)      │              │
       │  │ 5. session.sendingMsgNumber = 1    │              │
       │  └────────────────────────────────────┘              │
       │                                                      │
       │  ══════════════ ON-CHAIN TX ══════════════►         │
       │  Message event on Alice's topicOutbound              │
       │                                                      │
       │                                      verifySignature()
       │                                      ✓ Valid         │
       │                                                      │
       │                                      ratchetDecrypt()
       │                                      ┌────────────────────────────────────┐
       │                                      │ 1. header.dh ≠ dhTheirPub?         │
       │                                      │    YES! (dh1.public ≠ eA.public)   │
       │                                      │                                    │
       │                                      │ 2. DH Ratchet Step:                │
       │                                      │    dhRecv = DH(eB.secret, dh1.pub) │
       │                                      │    KDF_RK → rootKey', recvChain    │
       │                                      │                                    │
       │                                      │    Generate new DH:                │
       │                                      │    dh2 = generateDHKeyPair()       │
       │                                      │                                    │
       │                                      │    dhSend = DH(dh2.secret, dh1.pub)│
       │                                      │    KDF_RK → rootKey'', sendChain   │
       │                                      │                                    │
       │                                      │ 3. KDF_CK(recvChain) → messageKey  │
       │                                      │ 4. Decrypt → "Hello Bob!"          │
       │                                      └────────────────────────────────────┘
       │                                                      │
```

### Session State After Alice's First Message

```
    ┌──────────────────────────┐          ┌──────────────────────────┐
    │      ALICE SESSION       │          │       BOB SESSION        │
    ├──────────────────────────┤          ├──────────────────────────┤
    │ dhMyPub: dh1.public      │          │ dhMyPub: dh2.public ◄NEW │
    │ dhTheirPub: eB.public    │          │ dhTheirPub: dh1.public   │
    │                          │          │                          │
    │ sendingMsgNumber: 1      │          │ sendingMsgNumber: 0      │
    │ receivingMsgNumber: 0    │          │ receivingMsgNumber: 1    │
    └──────────────────────────┘          └──────────────────────────┘
```

### Scenario 2: Bob Replies

```
    ALICE                                                    BOB
    ═════                                                    ═══
       │                                                      │
       │                                      ratchetEncrypt("Hi Alice!")
       │                                      Header:         │
       │                                        dh = dh2.public
       │                                        pn = 0        │
       │                                        n = 0         │
       │                                                      │
       │         ◄══════════════ ON-CHAIN TX ════════════════ │
       │                                                      │
       │  verifySignature() ✓                                 │
       │                                                      │
       │  ratchetDecrypt()                                    │
       │  ┌────────────────────────────────────┐              │
       │  │ header.dh ≠ dhTheirPub?            │              │
       │  │ YES! (dh2.public ≠ eB.public)      │              │
       │  │                                    │              │
       │  │ DH Ratchet Step:                   │              │
       │  │   Generate dh3                     │              │
       │  │   Update chains                    │              │
       │  │                                    │              │
       │  │ Decrypt → "Hi Alice!"              │              │
       │  └────────────────────────────────────┘              │
       │                                                      │
```

### Scenario 3: Multiple Messages Same Direction (No DH Ratchet)

```
    BOB sends 3 messages without Alice replying:
    
    Message 1: header.dh = dh2.public, n = 0
    Message 2: header.dh = dh2.public, n = 1  ◄── Same DH key!
    Message 3: header.dh = dh2.public, n = 2
    
    Alice receives in order:
    - No DH ratchet needed (same header.dh)
    - Just advance receivingChainKey for each message
```

---

## Edge Cases

### Edge Case 1: Out-of-Order Messages (Skip Keys)

```
    BOB sends: Msg0, Msg1, Msg2
    
    ALICE receives in order: Msg2, Msg0, Msg1
    
    ┌─────────────────────────────────────────────────────────────────────────┐
    │ RECEIVE Msg2 (n=2, but Alice expects n=0)                               │
    ├─────────────────────────────────────────────────────────────────────────┤
    │ 1. header.n (2) > receivingMsgNumber (0)                                │
    │ 2. Skip messages 0 and 1:                                               │
    │    - Derive messageKey₀, store in skippedKeys                           │
    │    - Derive messageKey₁, store in skippedKeys                           │
    │ 3. Derive messageKey₂, decrypt Msg2                                     │
    │ 4. receivingMsgNumber = 3                                               │
    │                                                                         │
    │ skippedKeys = [                                                         │
    │   { dhPubKeyHex: "0x...", msgNumber: 0, messageKey: key₀ },             │
    │   { dhPubKeyHex: "0x...", msgNumber: 1, messageKey: key₁ },             │
    │ ]                                                                       │
    └─────────────────────────────────────────────────────────────────────────┘
    
    ┌─────────────────────────────────────────────────────────────────────────┐
    │ RECEIVE Msg0 (n=0, using skip key)                                      │
    ├─────────────────────────────────────────────────────────────────────────┤
    │ 1. Look up in skippedKeys: found!                                       │
    │ 2. Decrypt with stored messageKey₀                                      │
    │ 3. Remove key₀ from skippedKeys                                         │
    │ 4. Session state unchanged (no chain advance)                           │
    └─────────────────────────────────────────────────────────────────────────┘
    
    ┌─────────────────────────────────────────────────────────────────────────┐
    │ RECEIVE Msg1 (n=1, using skip key)                                      │
    ├─────────────────────────────────────────────────────────────────────────┤
    │ Same process, use stored messageKey₁                                    │
    └─────────────────────────────────────────────────────────────────────────┘
```

### Edge Case 2: DH Ratchet + Skip Keys Combined

```
    Scenario:
    - Bob sends Msg0, Msg1 with dh2.public
    - Alice replies (triggers Bob's DH ratchet to dh3)
    - Bob sends Msg0', Msg1' with dh3.public
    - Alice receives: Msg1' (new epoch), Msg0 (old epoch)
    
    ┌─────────────────────────────────────────────────────────────────────────┐
    │ RECEIVE Msg1' (new dh3.public, n=1)                                     │
    ├─────────────────────────────────────────────────────────────────────────┤
    │ 1. header.dh (dh3) ≠ dhTheirPub (dh2) → DH ratchet!                     │
    │ 2. But first: skip remaining msgs from OLD epoch (dh2)                  │
    │    header.pn = 2 means Bob sent 2 msgs on old chain                     │
    │    Alice received 0, so skip Msg0, Msg1 from old epoch                  │
    │    Store their keys tagged with dh2.public                              │
    │ 3. Perform DH ratchet (new receivingChain for dh3)                      │
    │ 4. Skip Msg0' in new epoch (n=1, expect n=0)                            │
    │    Store key tagged with dh3.public                                     │
    │ 5. Decrypt Msg1'                                                        │
    └─────────────────────────────────────────────────────────────────────────┘
    
    ┌─────────────────────────────────────────────────────────────────────────┐
    │ RECEIVE Msg0 (old dh2.public, n=0)                                      │
    ├─────────────────────────────────────────────────────────────────────────┤
    │ 1. Look up skippedKeys by (dh2.public, n=0)                             │
    │ 2. Found! Decrypt with stored key                                       │
    │ 3. Remove from skippedKeys                                              │
    └─────────────────────────────────────────────────────────────────────────┘
```

### Edge Case 3: Invalid Signature (DoS Attack)

```
    ATTACKER posts garbage message to Alice's topicInbound
    
    ┌─────────────────────────────────────────────────────────────────────────┐
    │ ALICE PROCESSING                                                        │
    ├─────────────────────────────────────────────────────────────────────────┤
    │ 1. parseRatchetPayload() → parsed                                       │
    │ 2. verifyMessageSignature(sig, header, ct, bob.signingPubKey)           │
    │    → FALSE ✗                                                            │
    │ 3. REJECT immediately                                                   │
    │    - No ratchet operations performed                                    │
    │    - No state changes                                                   │
    │    - O(1) cost (just signature verify)                                  │
    └─────────────────────────────────────────────────────────────────────────┘
    
    PROTECTION: Even if attacker sets header.n = 999999, we never
    reach the skip key derivation loop because signature fails first.
```

### Edge Case 4: Transaction Failure (Two-Phase Commit)

```
    ALICE tries to send message
    
    ┌─────────────────────────────────────────────────────────────────────────┐
    │ SEND FLOW WITH TWO-PHASE COMMIT                                         │
    ├─────────────────────────────────────────────────────────────────────────┤
    │ 1. Load session (sendingMsgNumber = 5)                                  │
    │                                                                         │
    │ 2. ratchetEncrypt() returns:                                            │
    │    - NEW session object (sendingMsgNumber = 6)                          │
    │    - Original session UNCHANGED                                         │
    │                                                                         │
    │ 3. Create PendingOutbound:                                              │
    │    { sessionBefore: original, sessionAfter: new }                       │
    │                                                                         │
    │ 4. Send transaction...                                                  │
    │                                                                         │
    │ IF TX SUCCEEDS:                        IF TX FAILS:                     │
    │ ├─ See event on-chain                  ├─ Delete PendingOutbound        │
    │ ├─ Commit sessionAfter to DB           ├─ Session state = original      │
    │ └─ Delete PendingOutbound              └─ User can retry                │
    │    sendingMsgNumber = 6                   sendingMsgNumber = 5          │
    └─────────────────────────────────────────────────────────────────────────┘
```

### Edge Case 5: Sequential Blocking (Prevent State Corruption)

```
    ALICE tries to send Msg A, then immediately Msg B
    
    ┌─────────────────────────────────────────────────────────────────────────┐
    │ PROBLEM WITHOUT BLOCKING                                                │
    ├─────────────────────────────────────────────────────────────────────────┤
    │ 1. Send Msg A: state 0 → 1, PendingA created                            │
    │ 2. Send Msg B: state 1 → 2, PendingB created                            │
    │ 3. TX A FAILS                                                           │
    │ 4. TX B SUCCEEDS (Bob receives it!)                                     │
    │                                                                         │
    │ If we rollback to state 0:                                              │
    │   - We've lost the keys for Msg B                                       │
    │   - Bob has Msg B but we can't continue                                 │
    │   - PERMANENT DESYNC                                                    │
    └─────────────────────────────────────────────────────────────────────────┘
    
    ┌─────────────────────────────────────────────────────────────────────────┐
    │ SOLUTION: SEQUENTIAL BLOCKING                                           │
    ├─────────────────────────────────────────────────────────────────────────┤
    │ 1. Send Msg A: PendingA created                                         │
    │ 2. Try to send Msg B: CHECK getPendingByConversation()                  │
    │    → PendingA exists!                                                   │
    │    → BLOCK: "Wait for previous message to confirm"                      │
    │ 3. TX A confirms (or fails)                                             │
    │ 4. NOW Alice can send Msg B                                             │
    │                                                                         │
    │ INVARIANT: At most ONE pending outbound per conversation                │
    └─────────────────────────────────────────────────────────────────────────┘
```

### Edge Case 6: Session Lost (Reset Required)

```
    ALICE clears browser storage or switches device
    
    ┌─────────────────────────────────────────────────────────────────────────┐
    │ DETECTION                                                               │
    ├─────────────────────────────────────────────────────────────────────────┤
    │ 1. Alice loads app, identity re-derived from wallet signature           │
    │ 2. Check for RatchetSession with Bob: NOT FOUND                         │
    │ 3. Contact exists but no session → SESSION LOST                         │
    └─────────────────────────────────────────────────────────────────────────┘
    
    ┌─────────────────────────────────────────────────────────────────────────┐
    │ RECOVERY: SESSION RESET PROTOCOL                                        │
    ├─────────────────────────────────────────────────────────────────────────┤
    │ 1. Alice sends NEW handshake to Bob                                     │
    │    (marked as reset, not first contact)                                 │
    │                                                                         │
    │ 2. Bob sees: "Alice requests new session"                               │
    │    - Warning: "Messages since [date] may be unreadable by Alice"        │
    │                                                                         │
    │ 3. Bob accepts → NEW session with NEW topics                            │
    │    - Old session marked 'inactive_superseded'                           │
    │    - Old messages still viewable (if cached)                            │
    │                                                                         │
    │ 4. Both continue with fresh ratchet state                               │
    └─────────────────────────────────────────────────────────────────────────┘
    
    ⚠️ TRADEOFF: Messages sent by Bob after Alice lost state and before
       Alice reset are PERMANENTLY LOST from Alice's perspective.
       This is inherent to forward secrecy.
```

---

## State Machine Summary

```
                    ┌─────────────────┐
                    │   NO SESSION    │
                    └────────┬────────┘
                             │ Handshake accepted
                             ▼
                    ┌─────────────────┐
        ┌──────────►│     ACTIVE      │◄──────────┐
        │           └────────┬────────┘           │
        │                    │                    │
        │    Send/Receive    │    State lost      │
        │    (normal ops)    │                    │
        │                    ▼                    │
        │           ┌─────────────────┐           │
        │           │ INACTIVE_RESET  │           │
        │           │ (waiting peer)  │           │
        │           └────────┬────────┘           │
        │                    │ Peer accepts       │
        │                    │ reset              │
        │                    ▼                    │
        │           ┌─────────────────┐           │
        └───────────│   NEW SESSION   │───────────┘
                    │ (new topics)    │
                    └─────────────────┘

    Old session → INACTIVE_SUPERSEDED → FROZEN (archival)
```

---

## Key Invariants

| Invariant | Description |
|-----------|-------------|
| **Auth First** | Always `verifyMessageSignature()` before `ratchetDecrypt()` |
| **Immutable Ops** | `ratchetEncrypt/Decrypt` return NEW session, never mutate |
| **Sequential Send** | Max 1 `PendingOutbound` per conversation |
| **Topics = Identity** | Session keyed by `conversationId` (from topics), not addresses |
| **Ephemeral Init** | Initial secret from ephemeral-only DH, no identity keys |
| **Skip Key TTL** | Skipped keys pruned after 24h |
| **Skip Key Cap** | Max 1000 stored skipped keys per session |