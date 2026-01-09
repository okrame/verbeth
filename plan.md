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

### 1.4 Two-Phase Commit (Sequential Blocking)

**Problem**: Advancing ratchet state before tx confirms risks permanent desync on failure.

**Solution**: Immutable operations + pending state with sequential blocking.

```
1. Check: pending outbound exists? → Block send
2. Load session
3. Compute (nextState, header, ciphertext) — DON'T save
4. Create PendingOutbound { prevState, nextState, txHash }
5. Send transaction
6. On SUCCESS: commit nextState, delete pending
7. On FAILURE: discard pending, session unchanged
```

**Constraint**: User cannot send message N+1 until transaction N confirms. This prevents dependent pending states.

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
───────┼──────┼─────────────────────────
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
- **Skipped keys**: Handle block reorgs and out-of-order RPC responses

| Concept | Purpose |
|---------|---------|
| Chain key derivation | Sequential catch-up after offline |
| Skipped keys | Out-of-order delivery tolerance |

Bounds:
- `MAX_STORED_SKIPPED_KEYS = 1000` (memory limit)
- `MAX_SKIPPED_KEYS_AGE_MS = 24h` (TTL)

---

## 2. State Loss & Session Reset

**Tradeoff**: Forward secrecy means lost local state = lost messages.

**Solution**: Session Reset Protocol
- User initiates new handshake to existing contact
- Creates new session with new topics
- Old session becomes `inactive_reset` (frozen, not deleted)
- Peer sees "Alice requests new session" notification

**UX**: "Session recovered - messages before [date] unavailable"

---

## 3. Implementation Milestones

No need to provide migration or backward compatibility.

### Milestone 1: SDK Ratchet Core ✅
Pure crypto module, fully testable without blockchain/DB.

**Files**: `ratchet/{types,kdf,session,encrypt,decrypt,codec,auth}.ts`

**Functions**:
- `initSessionAsResponder()`, `initSessionAsInitiator()`
- `ratchetEncrypt()`, `ratchetDecrypt()`
- `packageRatchetPayload()`, `parseRatchetPayload()`, `isRatchetPayload()`
- `verifyMessageSignature()`

### Milestone 2: Handshake + Persistence
Wire ratchet into handshake; sessions persist to IndexedDB.

**SDK Changes**:
- `send.ts`: Return two keypairs (tag + ratchet) from `respondToHandshake()`
- `VerbethClient.tsacceptHandshake()` returns ephemeral keys; `sendMessage()` REMOVED
- `crypto.ts` Mark `encryptMessage`/`decryptMessage` as `@deprecated`

**App Changes**:
- `types.ts`: Add `StoredRatchetSession`, `PendingOutbound`
- `schema.ts`: Add `ratchetSessions`, `pendingOutbound` tables
- `DbService.ts`: Add ~8 ratchet methods
- `useChatActions.ts`: Create session on `acceptHandshake`
- `useMessageProcessor.ts`: Create session on `HandshakeResponse`

**Key**: Ratchet key comes from decrypted payload, NOT on-chain `responderEphemeralR`.

### Milestone 3: Encrypted Messaging
Full send/receive with two-phase commit.

**App Changes**:
- `useChatActions.ts`: Rewrite `sendMessageToContact()` with sequential blocking
- `useMessageProcessor.ts`: Auth-first ratchet decrypt for incoming

**Test Cases**:
- Send → pending created → confirmed → session committed
- Send failure → session unchanged
- Sequential blocking → 2nd message blocked while 1st pending
- Invalid signature → rejected, no ratchet work

### Post-M3: Session Reset Protocol
Separate PR for recovery flow.

---

## 4. Success Criteria

**Cryptographic**:
- [ ] Identity key compromise never decrypts past messages (including message 0)
- [ ] Post-compromise security: session recovers after key compromise
- [ ] DoS resistance: unauthenticated messages rejected in O(1)
- [ ] Unlinkability: on-chain R ≠ message DH headers

**State Management**:
- [ ] Two-phase commit prevents desync on tx failure
- [ ] Sequential blocking: max one pending per conversation
- [ ] Session keyed by topics (not addresses)
- [ ] Confirmation matching by txHash

**Resilience**:
- [ ] Long offline periods: process in order, no skipped keys needed
- [ ] Skipped keys only for reorg tolerance (24h TTL)
- [ ] Session reset creates new topics (doesn't reuse old)

---

## 5. What's NOT in Scope

| Feature | Phase |
|---------|-------|
| Topic ratcheting | Phase 2 |
| Post-quantum (ML-KEM) | Phase 3 |
| Cloud sync | Future |
| Export/import | Future |