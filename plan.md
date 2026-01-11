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

## 2. State Loss & Session Reset

### 2.1 The Forward Secrecy Tradeoff

**Fundamental truth**: Forward secrecy means lost local state = lost messages.

The ratchet state is:
- **Stateful**: Each message advances the state irreversibly
- **Local-only**: Not stored on-chain or derivable from identity
- **Critical**: Without it, decryption is impossible

Topics are derived from `HKDF(DH(myIdentity, theirIdentity), salt)`. The salt comes from the handshake. Even if you re-derive identity, you need the salt (stored in contact) AND the ratchet state to decrypt.

### 2.3 Session Reset Protocol

When local state is lost, the ONLY option is to establish a new session:

```
1. User initiates new handshake to existing contact
2. Include flag/context: "session reset request"
3. Creates new session with NEW topics (new salt)
4. Old session becomes `inactive_reset` (frozen, not deleted)
5. Peer sees "Alice requests new session" notification
6. Peer accepts → both parties have fresh session
7. Old messages remain encrypted/unreadable
```

**UX**: "Session recovered - messages before [date] unavailable"

### 2.4 Detection & User Notification

The app should detect state loss and notify users:

```typescript
// On app startup after identity derivation
async function checkSessionIntegrity(address: string): Promise<SessionHealthCheck> {
  const contacts = await dbService.getAllContacts(address);
  const issues: SessionIssue[] = [];
  
  for (const contact of contacts) {
    if (contact.status === 'established' && contact.conversationId) {
      const session = await dbService.getRatchetSessionByConversation(contact.conversationId);
      
      if (!session) {
        issues.push({
          contactAddress: contact.address,
          type: 'missing_session',
          message: 'Ratchet session not found - reset required'
        });
      }
    }
  }
  
  return { healthy: issues.length === 0, issues };
}
```

---

## 3. Implementation Milestones

### Milestone 1: SDK Ratchet Core ✅ COMPLETED
### Milestone 2: Handshake + Persistence ✅ COMPLETED
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

### Milestone 4: Session Reset Protocol 🔄 IN PROGRESS

**Status**: Design complete, implementation pending.

#### 4.1 Scenarios Requiring Reset

| Trigger | Detection | Action |
|---------|-----------|--------|
| User clears IndexedDB | Missing session for established contact | Prompt: "Re-establish session with X?" |
| New device login | No sessions exist, contacts may exist | Prompt: "Restore backup or reset sessions?" |
| Corrupted ratchet state | Decryption fails repeatedly | Prompt: "Session corrupted, reset?" |
| User-initiated | Manual action | "Reset session with X" |

#### 4.2 Reset Flow Design

```
┌─────────────────────────────────────────────────────────────┐
│                     ALICE (State Lost)                      │
├─────────────────────────────────────────────────────────────┤
│ 1. Detect: session missing for established contact          │
│ 2. UI: "Session with Bob unavailable. Reset?"               │
│ 3. User confirms                                            │
│ 4. Mark old contact as "pending_reset"                      │
│ 5. Send new handshake with reset flag                       │
│    └─ plaintextPayload: { type: "session_reset", ... }      │
│ 6. Wait for response                                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     BOB (State Intact)                      │
├─────────────────────────────────────────────────────────────┤
│ 1. Receive handshake with reset flag                        │
│ 2. UI: "Alice requests session reset. Accept?"              │
│    └─ Warning: "Old messages will remain encrypted"         │
│ 3. User confirms                                            │
│ 4. Mark old session as "inactive_superseded"                │
│ 5. Accept handshake → create new session                    │
│ 6. Old messages: keep but mark "archived"                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    BOTH PARTIES                             │
├─────────────────────────────────────────────────────────────┤
│ • New session active with new topics                        │
│ • Old session frozen (read-only archive)                    │
│ • UI shows: "Session reset on [date]"                       │
│ • Old messages shown grayed: "Encrypted - session reset"    │
└─────────────────────────────────────────────────────────────┘
```

#### 4.3 Implementation Tasks

**SDK Changes**:
```typescript
// New type for handshake content
interface HandshakeContent {
  plaintextPayload: string;
  identityProof: IdentityProof;
  resetContext?: {
    type: 'session_reset';
    previousTopicOut?: `0x${string}`;  // For linking to old conversation
    reason?: 'state_lost' | 'user_initiated' | 'corruption';
  };
}
```

**App Changes**:

| File | Changes |
|------|---------|
| `types.ts` | Add `SessionResetRequest` type |
| `schema.ts` | Add index for finding reset-eligible sessions |
| `DbService.ts` | Add `markSessionAsReset()`, `getSessionsNeedingReset()` |
| `useMessageProcessor.ts` | Detect reset flag in incoming handshakes |
| `useChatActions.ts` | Add `initiateSessionReset()` action |
| `App.tsx` / UI | Reset UI, prompts, archived message display |

#### 4.4 Edge Cases

| Case | Handling |
|------|----------|
| Both parties lost state simultaneously | Both send reset → first one processed wins |
| Reset during active conversation | Pending messages fail, resend after reset |
| Malicious reset spam | Rate limit reset requests per contact |
| Partial state loss (some sessions ok) | Per-contact reset, not global |

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

### Session Reset 🔄
- [ ] Detect missing sessions for established contacts
- [ ] Reset handshake with context flag
- [ ] Peer notification and acceptance flow
- [ ] Old session archival (frozen, not deleted)
- [ ] UI for reset prompts and archived messages

---

## 6. What's NOT in Scope

| Feature | Phase |
|---------|-------|
| Topic ratcheting | Phase 2 |
| Post-quantum (ML-KEM) | Phase 3 |
| Cloud sync | Future |
| Export/import encryption | Future (current export is plaintext JSON) |