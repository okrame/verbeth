# Verbeth SDK: Double Ratchet Implementation Plan

## Overview

This plan implements Signal-style Double Ratchet for bilateral forward secrecy. Compromising identity keys never allows decrypting past messages—not even message 0.

**Scope**: Core Double Ratchet only. Topic ratcheting and post-quantum are separate future phases.

---

## 1. Key Design Decisions

### 1.1 Ephemeral-Only Initial Secret

**Traditional Signal**: Initial secret includes identity keys → identity compromise exposes message 0.

**Verbeth**: Initial secret is `DH(AliceEphemeral, BobRatchetEphemeral)` ONLY.
- No identity keys in initial secret
- Authentication via Ed25519 signatures on every message
- Identity compromise never decrypts any messages

### 1.2 Two-Keypair Handshake (Unlinkability)

Bob's `respondToHandshake` generates TWO separate keypairs:

| Keypair | Purpose | Location |
|---------|---------|----------|
| `tagKeyPair (R, r)` | Compute `inResponseTo` tag | `R` on-chain as `responderEphemeralR` |
| `ratchetKeyPair` | First DH ratchet key | Public key inside encrypted payload |

**Why**: Single keypair would let observers link `HandshakeResponse.R` to first message's DH header. With separation, no on-chain link exists between handshake and conversation.

### 1.3 Session Keyed by Topics

Sessions keyed by `conversationId = keccak256(sort([topicOut, topicIn]))`, not addresses.

```typescript
interface RatchetSession {
  conversationId: string;
  topicOutbound: `0x${string}`;
  topicInbound: `0x${string}`;
  // ... ratchet state
}
```

Lookup: `session where topicInbound === event.topic`

### 1.4 Immediate Session Commit (Skip-Key Resilient)

**Original design**: Two-phase commit with sequential blocking.

**Implemented design**: Immediate session commit after encryption.

```
1. Load session (from cache or DB)
2. Compute (nextState, header, ciphertext)
3. Save nextState to DB IMMEDIATELY
4. Send transaction
5. On SUCCESS: clean up pending record
6. On FAILURE: ratchet "slot" is burned, receiver handles via skip keys
```

**Why this works**:
- The ratchet protocol is designed for message loss
- Receivers handle gaps via skip-key mechanism
- Saving session immediately ensures subsequent messages use the advanced state
- Matches how Signal handles message failures

### 1.5 Auth-Before-Ratchet (DoS Protection)

**Attack**: Malicious `pn=999999, n=999999` forces millions of key derivations.

**Defense**: Verify Ed25519 signature BEFORE any ratchet work.

```
1. Parse sig + header + ciphertext
2. Verify Ed25519(sig, header || ct, contact.signingPubKey)
3. IF invalid: reject (O(1) cost)
4. THEN attempt ratchet decrypt
```

### 1.6 Binary Encoding

```
Offset │ Size │ Field
───────┼──────┼─────────────────────────────
0      │ 1    │ Version (0x01)
1      │ 64   │ Ed25519 signature
65     │ 32   │ DH ratchet public key
97     │ 4    │ pn (uint32 BE)
101    │ 4    │ n (uint32 BE)
105    │ var  │ Ciphertext (nonce + AEAD)
```

Fixed overhead: ~105 bytes (vs ~200+ for JSON+base64).

### 1.7 Skipped Keys: Reorg Tolerance, Not Offline Catch-Up

**Common misconception**: Skipped keys handle offline periods.

**Reality**: 
- **Offline catch-up**: Process chain logs in order → chain key advances sequentially → no skipped keys
- **Skipped keys**: Handle block reorgs, out-of-order RPC responses, and failed transactions

| Concept | Purpose |
|---------|---------|
| Chain key derivation | Sequential catch-up after offline |
| Skipped keys | Out-of-order delivery + tx failure tolerance |

Bounds:
- `MAX_STORED_SKIPPED_KEYS = 1000` (memory limit)
- `MAX_SKIPPED_KEYS_AGE_MS = 24h` (TTL)

---

## 2. State Loss & Recovery

### 2.1 The Forward Secrecy Tradeoff

**Fundamental truth**: Forward secrecy means lost local state = lost messages.

The ratchet state is:
- **Stateful**: Each message advances the state irreversibly
- **Local-only**: Not stored on-chain or derivable from identity
- **Critical**: Without it, decryption is impossible

### 2.2 When State Loss Occurs

| Scenario | What's Lost | Recovery Path |
|----------|-------------|---------------|
| Browser IndexedDB cleared | Everything | Re-handshake all contacts |
| New device, same identity | Everything | Re-handshake all contacts |
| Corrupted database | Depends | Re-handshake affected contacts |
| Export then Import | Nothing | Seamless (ratchet state preserved) |

### 2.3 Recovery: Just Re-Handshake

No special "reset protocol" needed. The existing handshake flow handles recovery:

```
Alice (lost state) → sendHandshake(bob) → Bob accepts → New session
```

- New ephemeral keys generate new salt → new topics
- Old ratchet session orphaned in Bob's DB (harmless)
- Both parties continue with fresh session

**UX implication**: Alice must manually re-initiate contact with each peer. This is acceptable; cloud sync (future) would eliminate this friction.

---

## 3. Implementation Milestones

### Milestone 1: SDK Ratchet Core ✅ COMPLETED
Pure crypto module, fully testable without blockchain/DB.

### Milestone 2: Handshake + Persistence ✅ COMPLETED
Wire ratchet into handshake; sessions persist to IndexedDB.
Ratchet key comes from decrypted payload, NOT on-chain `responderEphemeralR`.

### Milestone 3: Encrypted Messaging ✅ COMPLETED
Full send/receive with session caching and batch processing.

**Implementation Details**:

| Component | Status | Notes |
|-----------|--------|-------|
| `useMessageQueue.ts` | ✅ | Sequential message processing with optimistic UI |
| Session caching | ✅ | Per-conversation cache in `sessionCacheRef` |
| Immediate session commit | ✅ | DB save before tx send (skip-key resilient) |
| Batch incoming processing | ✅ | `processMessageLogWithCache()` with shared cache |
| Auth-first decryption | ✅ | `verifyMessageSignature()` before `ratchetDecrypt()` |
| Pending outbound tracking | ✅ | `PendingOutbound` table for tx confirmation matching |
| Retry failed messages | ✅ | Re-encrypts with current state (burns new slot) |

**Test Cases Verified**:
- ✅ Send → pending created → confirmed → session committed
- ✅ Send failure → session already advanced, skip key handles gap
- ✅ Batch incoming → session cache ensures sequential decryption
- ✅ Invalid signature → rejected before ratchet work (DoS protection)

### Milestone 4: Session Recovery UX

**Status**: Existing handshake flow (probably) handles reset naturally.

#### 4.1 Why No Special Protocol Needed

```
Alice (lost state) → sends new handshake → Bob accepts → new session created
```

What happens:
1. Alice's contact record gets overwritten with `status: "handshake_sent"`
2. New ephemeral keys → new salt → new topics
3. Bob sees pending handshake, accepts it
4. New ratchet session created, old one orphaned (but harmless)


#### 4.2 What's Actually Missing (Nice-to-Have UX)

| Enhancement | Description | Priority |
|-------------|-------------|----------|
| Startup health check | Detect "contacts exist but sessions missing" | Low |
| Receiver hint | Bob sees "Alice (existing contact) requests new session" vs confusing duplicate | Medium |
| Orphan cleanup | Periodically delete ratchet sessions with no matching contact | Low |
| Chat boundary | Visual indicator "Session reset on [date]" | Low |

#### 4.3 Current Behavior (Acceptable but improvable)

| Scenario | What Happens | User Experience |
|----------|--------------|-----------------|
| Alice clears IndexedDB | Loses everything, must re-handshake all contacts | "Start fresh" - acceptable |
| Alice on new device | No data, must re-handshake | Same as new user - acceptable |
| Bob receives 2nd handshake from Alice | Sees new pending request | Slightly confusing but works |
| Old ratchet session | Orphaned in DB | No functional impact |

---

## 4. Future Improvements

### 4.1 Cloud Sync (Planned)

**Problem**: Device loss = data loss.

**Solution**: Encrypted cloud backup of full database state.

```
┌─────────────────────────────────────────────────────────────┐
│                     CLOUD SYNC FLOW                         │
├─────────────────────────────────────────────────────────────┤
│ 1. Derive backup key: HKDF(identitySeed, "verbeth-backup")  │
│ 2. Serialize: { contacts, messages, ratchetSessions, ... }  │
│ 3. Encrypt: AES-GCM(backupKey, serializedData)              │
│ 4. Upload to user's cloud storage (Drive/iCloud/S3)         │
│ 5. On new device: download, decrypt, import                 │
│ 6. Ratchet state restored → no reset needed                 │
└─────────────────────────────────────────────────────────────┘
```

**Key properties**:
- Backup key derived from identity → only owner can decrypt
- Cloud provider never sees plaintext
- Backup includes ratchet state → seamless device migration
- Optional: encrypted sync on every state change

**Implementation scope**: Separate feature, not part of core ratchet.

### 4.2 Topic Ratcheting (Phase 2)

Periodic topic rotation for enhanced metadata privacy.

### 4.3 Post-Quantum (Phase 3)

ML-KEM hybrid for quantum resistance.

---

## 5. Success Criteria

### Cryptographic ✅
- [x] Identity key compromise never decrypts past messages (including message 0)
- [x] Post-compromise security: session recovers after key compromise
- [x] DoS resistance: unauthenticated messages rejected in O(1)
- [x] Unlinkability: on-chain R ≠ message DH headers

### State Management ✅
- [x] Immediate session commit with skip-key resilience
- [x] Session caching: in-memory cache + DB persistence
- [x] Session keyed by topics (not addresses)
- [x] Confirmation matching by txHash

### Resilience ✅
- [x] Long offline periods: process in order, no skipped keys needed
- [x] Skipped keys for reorg tolerance (24h TTL)
- [x] Batch message processing with shared session cache

### Session Reset ⏳ DEFERRED (handled implicitly by existing handshake)
- [x] New handshake to existing contact creates fresh session
- [x] Old session orphaned (no functional impact)
- [ ] *(Nice-to-have)* Detect missing sessions on startup
- [ ] *(Nice-to-have)* UI hint for "existing contact requests new session"
- [ ] *(Nice-to-have)* Cleanup orphaned sessions

---

## 6. What's NOT in Scope

| Feature | Phase |
|---------|-------|
| Topic ratcheting | Phase 2 |
| Post-quantum (ML-KEM) | Phase 3 |
| Cloud sync | Future |
| Export/import encryption | Future (current export is plaintext JSON) |