# Verbeth SDK: Double Ratchet Implementation Plan

## Overview

This plan implements Signal-style Double Ratchet for bilateral forward secrecy and topic unlinkability. Compromising identity keys never allows decrypting past messages—not even message 0.

**Scope**: Core Double Ratchet only. Post-quantum are separate future phases.

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

# DH-Synchronized Topic Ratcheting

Static topics enable long-term correlation of conversations by on-chain observers. Even with encrypted content, the repeated `topic` parameter in `MessageSent` events creates a linkable pattern.

## Solution: DH-Synchronized Topic Ratcheting

Derive new topics whenever a DH ratchet step occurs. The DH public key in message headers provides natural synchronization—both parties know when to rotate topics without additional coordination.

## Key Insight

The existing Double Ratchet already:
- Generates new DH keypairs on each turn (in `dhRatchetStep()`)
- Tracks `dhMyPublicKey` and `dhTheirPublicKey`
- Triggers on first message after receiving a new DH public key

**Topic epochs = DH epochs.** When `dhTheirPublicKey` changes, derive new topics.

---

## Topic Transition Window (5 minutes) — NOT a Wait Time

The transition window is a **grace period**, not a delay. Messages flow instantly with zero UX impact.

**What it means:**
- After a DH ratchet step, we listen on BOTH the old topic AND the new topic for 5 minutes
- Messages sent/received immediately on the new topic
- Old topic acceptance handles edge cases only

**Why it's needed:**
1. **In-flight messages** — A message encrypted before rotation may arrive after rotation
2. **Timing skew** — Parties don't ratchet at the exact same millisecond
3. **Block propagation** — On-chain message may be mined slightly out of order

**Example timeline:**
```
t=0:00  Alice sends msg#5, triggers DH ratchet → new topic T2
t=0:01  Alice sends msg#6 on T2 ✓
t=0:03  Bob receives msg#5, triggers his DH ratchet → derives same T2
t=0:04  Bob receives msg#6 on T2 ✓
t=0:05  Bob sends reply on T2 ✓
```

No waiting. The window just ensures we don't drop the rare out-of-order message.

---

# Part 1: SDK Changes (`packages/sdk/`)

## 1.1 Add `deriveTopicFromDH()` in `kdf.ts`

```typescript
// packages/sdk/src/ratchet/kdf.ts

import { keccak256 } from 'ethers';

/**
 * Derive topic from DH shared secret.
 * Called after each DH ratchet step.
 */
export function deriveTopicFromDH(
  dhSharedSecret: Uint8Array,
  direction: 'outbound' | 'inbound',
  salt: Uint8Array  // conversationId bytes
): `0x${string}` {
  const info = `verbeth:topic-${direction}:v2`;
  const okm = hkdf(sha256, dhSharedSecret, salt, info, 32);
  return keccak256(okm) as `0x${string}`;
}
```

---

## 1.2 Extend `RatchetSession` in `types.ts`

```typescript
// packages/sdk/src/ratchet/types.ts

export const TOPIC_TRANSITION_WINDOW_MS = 5 * 60 * 1000;

export interface RatchetSession {
  // ... existing fields ...

  // === Topic Ratcheting ===
  /** Current outbound topic (ratcheted) */
  currentTopicOutbound: `0x${string}`;
  /** Current inbound topic (ratcheted) */
  currentTopicInbound: `0x${string}`;
  
  /** Previous inbound topic (grace period) */
  previousTopicInbound?: `0x${string}`;
  /** When to stop accepting on previous topic */
  previousTopicExpiry?: number;
  
  /** Topic epoch (increments with DH steps) */
  topicEpoch: number;
}
```

---

## 1.3 Update `initSessionAsResponder()` in `session.ts`

```typescript
// packages/sdk/src/ratchet/session.ts

export function initSessionAsResponder(params: InitResponderParams): RatchetSession {
  // ... existing DH and chain key derivation ...

  return {
    // ... existing fields ...
    
    // Epoch 0: use handshake-derived topics
    currentTopicOutbound: topicOutbound,
    currentTopicInbound: topicInbound,
    previousTopicInbound: undefined,
    previousTopicExpiry: undefined,
    topicEpoch: 0,
  };
}
```

---

## 1.4 Update `initSessionAsInitiator()` in `session.ts`

```typescript
// packages/sdk/src/ratchet/session.ts

export function initSessionAsInitiator(params: InitInitiatorParams): RatchetSession {
  // ... existing DH ratchet step (generates myDHKeyPair, computes dhSend) ...
  
  // Derive first ratcheted topics from dhSend
  const saltBytes = getBytes(computeConversationId(topicOutbound, topicInbound));
  const ratchetedTopicOut = deriveTopicFromDH(dhSend, 'outbound', saltBytes);
  const ratchetedTopicIn = deriveTopicFromDH(dhSend, 'inbound', saltBytes);

  return {
    // ... existing fields ...
    
    // Epoch 1: initiator already did first DH step
    currentTopicOutbound: ratchetedTopicOut,
    currentTopicInbound: ratchetedTopicIn,
    previousTopicInbound: topicInbound,
    previousTopicExpiry: Date.now() + TOPIC_TRANSITION_WINDOW_MS,
    topicEpoch: 1,
  };
}
```

---

## 1.5 Update `dhRatchetStep()` in `decrypt.ts`

```typescript
// packages/sdk/src/ratchet/decrypt.ts

function dhRatchetStep(session: RatchetSession, theirNewDHPub: Uint8Array): RatchetSession {
  // ... existing: compute dhReceive, rootKey1, receivingChainKey ...
  // ... existing: generate newDHKeyPair ...
  // ... existing: compute dhSend, rootKey2, sendingChainKey ...
  
  // NEW: Derive ratcheted topics from dhSend
  const saltBytes = getBytes(session.conversationId);
  const newTopicOut = deriveTopicFromDH(dhSend, 'outbound', saltBytes);
  const newTopicIn = deriveTopicFromDH(dhSend, 'inbound', saltBytes);

  return {
    ...session,
    rootKey: rootKey2,
    dhMySecretKey: newDHKeyPair.secretKey,
    dhMyPublicKey: newDHKeyPair.publicKey,
    dhTheirPublicKey: theirNewDHPub,
    receivingChainKey,
    receivingMsgNumber: 0,
    sendingChainKey,
    sendingMsgNumber: 0,
    previousChainLength: session.sendingMsgNumber,
    
    // Topic ratcheting
    currentTopicOutbound: newTopicOut,
    currentTopicInbound: newTopicIn,
    previousTopicInbound: session.currentTopicInbound,
    previousTopicExpiry: Date.now() + TOPIC_TRANSITION_WINDOW_MS,
    topicEpoch: session.topicEpoch + 1,
  };
}
```

---

## 1.6 Add `matchesSessionTopic()` helper in `decrypt.ts`

```typescript
// packages/sdk/src/ratchet/decrypt.ts

/**
 * Check if topic matches this session.
 * Returns match type or null.
 */
export function matchesSessionTopic(
  session: RatchetSession, 
  topic: `0x${string}`
): 'current' | 'previous' | null {
  const t = topic.toLowerCase();
  
  if (session.currentTopicInbound.toLowerCase() === t) {
    return 'current';
  }
  
  if (
    session.previousTopicInbound?.toLowerCase() === t &&
    session.previousTopicExpiry &&
    Date.now() < session.previousTopicExpiry
  ) {
    return 'previous';
  }
  
  return null;
}
```

---

## 1.7 Update `ratchetEncrypt()` in `encrypt.ts`

```typescript
// packages/sdk/src/ratchet/encrypt.ts

export interface EncryptResult {
  session: RatchetSession;
  header: MessageHeader;
  ciphertext: Uint8Array;
  signature: Uint8Array;
  topic: `0x${string}`;  // NEW
}

export function ratchetEncrypt(
  session: RatchetSession,
  plaintext: Uint8Array,
  signingSecretKey: Uint8Array
): EncryptResult {
  // ... existing encryption ...

  return {
    session: newSession,
    header,
    ciphertext: encryptedPayload,
    signature,
    topic: session.currentTopicOutbound,  // NEW: return current topic
  };
}
```

---

## 1.8 Export new functions in `index.ts`

```typescript
// packages/sdk/src/ratchet/index.ts

export { 
  // ... existing exports ...
  deriveTopicFromDH,
  matchesSessionTopic,
  TOPIC_TRANSITION_WINDOW_MS,
} from './kdf.js';
```

---

# Part 2: App Layer Changes

## 2.1 Update `StoredRatchetSession` in `types.ts`

```typescript
// src/types.ts

export interface StoredRatchetSession {
  // ... existing fields ...
  
  currentTopicOutbound: string;
  currentTopicInbound: string;
  previousTopicInbound?: string;
  previousTopicExpiry?: number;
  topicEpoch: number;
}
```

---

## 2.2 Update serialization in `types.ts`

```typescript
// src/types.ts

export function serializeRatchetSession(session: RatchetSession): StoredRatchetSession {
  return {
    // ... existing ...
    currentTopicOutbound: session.currentTopicOutbound,
    currentTopicInbound: session.currentTopicInbound,
    previousTopicInbound: session.previousTopicInbound,
    previousTopicExpiry: session.previousTopicExpiry,
    topicEpoch: session.topicEpoch,
  };
}

export function deserializeRatchetSession(stored: StoredRatchetSession): RatchetSession {
  return {
    // ... existing ...
    currentTopicOutbound: stored.currentTopicOutbound as `0x${string}`,
    currentTopicInbound: stored.currentTopicInbound as `0x${string}`,
    previousTopicInbound: stored.previousTopicInbound as `0x${string}` | undefined,
    previousTopicExpiry: stored.previousTopicExpiry,
    topicEpoch: stored.topicEpoch,
  };
}
```

---

## 2.3 Update `schema.ts` — Add indexes

```typescript
// src/services/schema.ts

this.version(2).stores({
  // ... existing ...
  ratchetSessions: 
    "conversationId, topicInbound, topicOutbound, currentTopicInbound, previousTopicInbound, myAddress, contactAddress",
});
```

---

## 2.4 Update `RatchetDbService.ts` — Multi-topic lookup

```typescript
// src/services/RatchetDbService.ts

/**
 * Find session by any active inbound topic (current or previous).
 */
async getRatchetSessionByAnyInboundTopic(topic: string): Promise {
  const topicLower = topic.toLowerCase();
  
  // Try current topic first
  let stored = await this.db.ratchetSessions
    .where("currentTopicInbound")
    .equals(topicLower)
    .first();
    
  if (stored) {
    return deserializeRatchetSession(stored);
  }
  
  // Try previous topic (check expiry in caller)
  stored = await this.db.ratchetSessions
    .where("previousTopicInbound")
    .equals(topicLower)
    .first();
    
  if (stored && stored.previousTopicExpiry && Date.now() < stored.previousTopicExpiry) {
    return deserializeRatchetSession(stored);
  }
  
  return null;
}

/**
 * Get all active inbound topics for a user (for event filtering).
 */
async getAllActiveInboundTopics(myAddress: string): Promise {
  const sessions = await this.db.ratchetSessions
    .where("myAddress")
    .equals(myAddress.toLowerCase())
    .toArray();
    
  const topics: string[] = [];
  const now = Date.now();
  
  for (const s of sessions) {
    topics.push(s.currentTopicInbound);
    if (s.previousTopicInbound && s.previousTopicExpiry && now < s.previousTopicExpiry) {
      topics.push(s.previousTopicInbound);
    }
  }
  
  return [...new Set(topics)]; // dedupe
}
```

---

## 2.5 Update `EventProcessorService.ts` — Use multi-topic lookup

```typescript
// src/services/EventProcessorService.ts

export async function processMessageEvent(
  event: ProcessedEvent,
  address: string,
  emitterAddress: string | undefined,
  sessionCache: Map,
  onLog: (msg: string) => void
): Promise {
  // ... existing setup ...
  
  const topic = log.topics[2];
  
  // UPDATED: Check cache by topic, then fall back to multi-topic DB lookup
  let session = sessionCache.get(topic);
  
  if (!session) {
    session = await dbService.getRatchetSessionByAnyInboundTopic(topic) || undefined;
    
    if (session) {
      sessionCache.set(topic, session);
    }
  }
  
  if (!session) {
    onLog(`❓ Unknown topic: ${topic.slice(0, 10)}...`);
    return null;
  }
  
  // ... rest unchanged (signature verify, decrypt, etc.) ...
}
```

---

## 2.6 Update `useMessageListener.ts` — Query all active topics

```typescript
// src/hooks/useMessageListener.ts

const scanBlockRange = async (fromBlock: number, toBlock: number): Promise => {
  // ... existing handshake scanning ...
  
  // UPDATED: Get ALL active inbound topics for this user
  const activeTopics = await dbService.getAllActiveInboundTopics(address);
  
  if (activeTopics.length > 0) {
    // Query each topic (or batch if RPC supports OR filters)
    for (const topic of activeTopics) {
      const messageFilter = {
        address: LOGCHAIN_SINGLETON_ADDR,
        topics: [EVENT_SIGNATURES.MessageSent, null, topic],
      };
      const inboundLogs = await safeGetLogs(messageFilter, fromBlock, toBlock);
      
      for (const log of inboundLogs) {
        const logKey = `${log.transactionHash}-${log.logIndex}`;
        if (!processedLogs.current.has(logKey)) {
          processedLogs.current.add(logKey);
          allEvents.push({
            logKey,
            eventType: "message",
            rawLog: log,
            blockNumber: log.blockNumber,
            timestamp: Date.now(),
          });
        }
      }
    }
  }
  
  // .. existing outbound confirmation scanning (unchanged) ...
};
```

---

## 2.7 Update `useMessageQueue.ts` (or equivalent) — Use `EncryptResult.topic`

```typescript
// In your message queue / sending logic

const sendMessage = async (session: RatchetSession, plaintext: string) => {
  const encryptResult = ratchetEncrypt(
    session,
    new TextEncoder().encode(plaintext),
    identityKeyPair.signingSecretKey
  );
  
  const payload = packageRatchetPayload(
    encryptResult.signature,
    encryptResult.header,
    encryptResult.ciphertext
  );
  
  // UPDATED: Use topic from encrypt result, not session.topicOutbound
  await executor.sendMessage(
    payload,
    encryptResult.topic,  // ← ratcheted topic
    Date.now(),
    nonce
  );
  
  // Persist updated session
  await dbService.saveRatchetSession(encryptResult.session);
};
```

---

## 2.8 Update `useChatActions.ts` — No direct changes needed

The hook delegates to `useMessageQueue` which handles encryption. Ensure `useMessageQueue` passes through the `EncryptResult.topic` as shown above.

---

## 2.9 Update `useMessageProcessor.ts` — No direct changes needed

The hook calls `processMessageEvent` from `EventProcessorService`, which now handles multi-topic lookup internally.

---

# Implementation Order

| # | Layer | File(s) | Change |
|---|-------|---------|--------|
| 1 | SDK | `kdf.ts` | Add `deriveTopicFromDH()` |
| 2 | SDK | `types.ts` | Extend `RatchetSession`, add constant |
| 3 | SDK | `session.ts` | Update both `initSession*` functions |
| 4 | SDK | `decrypt.ts` | Update `dhRatchetStep()`, add `matchesSessionTopic()` |
| 5 | SDK | `encrypt.ts` | Return `topic` in `EncryptResult` |
| 6 | SDK | `index.ts` | Export new functions |
| 7 | App | `types.ts` | Update `StoredRatchetSession`, serialization |
| 8 | App | `schema.ts` | Add `currentTopicInbound`, `previousTopicInbound` indexes |
| 9 | App | `RatchetDbService.ts` | Add `getRatchetSessionByAnyInboundTopic()`, `getAllActiveInboundTopics()` |
| 10 | App | `EventProcessorService.ts` | Use multi-topic lookup |
| 11 | App | `useMessageListener.ts` | Query all active topics |
| 12 | App | `useMessageQueue.ts` | Use `EncryptResult.topic` for sending |

---

# Testing Checklist

- [ ] New session (epoch 0): messages use handshake topics
- [ ] Initiator's first message: uses ratcheted topic (epoch 1)
- [ ] Responder receives on ratcheted topic after their DH step
- [ ] Both parties derive identical topics from same DH output
- [ ] Message on previous topic (within window) decrypts successfully
- [ ] Message on expired previous topic is rejected
- [ ] On-chain: observe topic changes after each conversational turn

---

# Security Notes

1. **Deterministic** — Both parties derive identical topics from `dhSend`
2. **No extra metadata** — Epoch not transmitted; derived from DH state
3. **Unlinkable** — After first DH step, new topic has no on-chain link to handshake
4. **Grace period** — Prevents message loss without adding latency
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