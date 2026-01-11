# VerbEth Double Ratchet Protocol

## Core Design: Ephemeral-Only Initial Secret

| | Signal X3DH | VerbEth |
|---|---|---|
| Initial secret | `DH(IKa,SPKb) ∥ DH(EKa,IKb) ∥ DH(EKa,SPKb)` | `DH(EKa, EKb)` |
| Identity keys in secret | Yes | No |
| First message | Encrypted | Plaintext handshake |
| Authentication | Mixed into DH | On-chain `msg.sender` + binding proof |
| Forward secrecy on identity compromise | Initial secret derivable | Initial secret independent |
| Prekey infrastructure | Required | None |

**The tradeoff:** By accepting a plaintext handshake, VerbEth gains unconditional forward secrecy from message 0 and trustless authentication via Ethereum's transaction model.

---

## Session Model

### What is a Session?

A **RatchetSession** is the complete cryptographic state required for bidirectional encrypted messaging. It is:
- **Stateful**: Every encrypt/decrypt operation produces a new session state that must replace the old one
- **Keyed by `conversationId`**: Derived from `keccak256(sort([topicOut, topicIn]))`, not addresses—this handles Safe vs EOA correctly
- **Bilateral**: Both parties maintain symmetric (but not identical) session states

```typescript
interface RatchetSession {
  // Identity
  conversationId: string;        // Primary key
  topicOutbound: `0x${string}`;  // My sending topic
  topicInbound: `0x${string}`;   // My receiving topic
  
  // Root ratchet
  rootKey: Uint8Array;           // Advances on every DH ratchet step
  
  // DH ratchet keys
  dhMySecretKey: Uint8Array;     // My current DH secret
  dhMyPublicKey: Uint8Array;     // Sent in message headers
  dhTheirPublicKey: Uint8Array;  // Their last received DH key
  
  // Sending chain
  sendingChainKey: Uint8Array | null;
  sendingMsgNumber: number;      // Next message number (Ns)
  
  // Receiving chain
  receivingChainKey: Uint8Array | null;
  receivingMsgNumber: number;    // Next expected (Nr)
  
  // Skip handling
  previousChainLength: number;   // PN header field
  skippedKeys: SkippedKey[];     // For out-of-order decryption
  
  // Metadata
  epoch: number;                 // Increments on session reset
  status: SessionStatus;
}
```

### Session Initialization

**Responder (Bob)** creates session when accepting handshake:
```
sharedSecret = DH(bobEphemeral, aliceEphemeral)
rootKey, sendingChainKey = KDF(zeros, sharedSecret)
```

**Initiator (Alice)** creates session after receiving response:
```
sharedSecret = DH(aliceEphemeral, bobRatchetEphemeral)  // From INSIDE payload, not on-chain R
rootKey, bobsSendingChain = KDF(zeros, sharedSecret)
// Immediate DH ratchet step:
aliceDHKeyPair = generateDHKeyPair()
finalRootKey, sendingChainKey = KDF(rootKey, DH(aliceSecret, bobRatchetEphemeral))
receivingChainKey = bobsSendingChain
```

Note: Bob's on-chain `responderEphemeralR` is used only for tag verification. His ratchet ephemeral is inside the encrypted payload—this provides **unlinkability** between the HandshakeResponse and subsequent messages.

---

## SDK vs App Layer Responsibilities

| Concern | SDK (`@verbeth/sdk/ratchet`) | App Layer |
|---------|------------------------------|-----------|
| Session state | Produces new immutable session on each operation | Persists session to IndexedDB, manages cache |
| Encryption | `ratchetEncrypt()` → returns `{session, header, ciphertext, signature}` | Decides when to commit session state |
| Decryption | `ratchetDecrypt()` → returns `{session, plaintext}` or null | Handles signature verification first |
| Skip keys | Creates/uses/prunes skip keys automatically | Calls `pruneExpiredSkippedKeys()` periodically |
| DoS protection | Provides `verifyMessageSignature()` | Must call before any ratchet operation |
| Two-phase commit | Returns new session without mutating input | Implements commit/rollback logic |
| Concurrent access | None (pure functions) | Must serialize per-conversation |
| Transaction failures | N/A | Decides whether to burn slot or rollback |
| Message queue | N/A | Sequential processing per conversation |

---

## Edge Cases and Crypto Safety

### Edge Case 1: Out-of-Order Messages

**Scenario:** Bob sends messages 0, 1, 2. Alice receives 2, then 0, then 1.

**SDK handling:**
```
Receive msg 2 (n=2, expected Nr=0):
  → Skip n=0,1: derive and store skip keys for both
  → Decrypt msg 2 with derived key for n=2
  → Update: Nr=3, skippedKeys=[{n:0}, {n:1}]

Receive msg 0:
  → Found in skippedKeys → decrypt, remove from list

Receive msg 1:
  → Found in skippedKeys → decrypt, remove from list
```

**Bounds:**
- `MAX_SKIP_PER_MESSAGE = 100,000` — rejects messages requiring more skips
- `MAX_STORED_SKIPPED_KEYS = 1,000` — oldest pruned when exceeded
- `MAX_SKIPPED_KEYS_AGE_MS = 24h` — expired keys pruned

### Edge Case 2: Burned Slots (Failed Sends)

**Scenario:** Bob encrypts messages 0, 1, 2. Message 1's tx fails. Alice only receives 0 and 2.

**Why rollback is forbidden:** Rolling back session state would reuse encryption keys—a critical security violation. Each key must be used exactly once.

**App layer handling (matches Signal):**
```typescript
// useMessageQueue.ts
const { session: nextSession, ... } = ratchetEncrypt(currentSession, plaintext, signingKey);

// Commit IMMEDIATELY, before tx submission
currentSession = nextSession;
await dbService.saveRatchetSession(nextSession);

try {
  await sendTransaction(payload);
} catch {
  // Slot is "burned" — do NOT rollback
  // Receiver will create an orphan skip key for n=1
}
```

**Receiver impact:** Alice creates a skip key for n=1 that will never be used. This skip key expires after 24h and is pruned.

### Edge Case 3: Retry with New Message Number

**Scenario:** Message "Hello" fails at n=1. User retries. It now encrypts at n=3.

**This is safe because:**
1. Each slot gets a unique key from chain ratchet
2. Receiver handles gaps via skip keys
3. No cryptographic material is reused
4. Message content can repeat; key material cannot

**App consideration:** UI should sort by `blockTimestamp`, not message number. The retry appears in chronological order regardless of its `n` value.

### Edge Case 4: DH Ratchet Advancement

**Scenario:** Alice and Bob alternate messages (ping-pong pattern).

**What happens:**
```
Bob→Alice (msg 0): header.dh = BobDH₀
Alice→Bob (msg 0): header.dh = AliceDH₁ (new keypair!)
  → Bob performs DH ratchet: new rootKey, new chains
Bob→Alice (msg 0): header.dh = BobDH₁ (new keypair!)
  → Alice performs DH ratchet
```

Each direction change triggers a DH ratchet step, advancing forward secrecy. Even if an attacker compromises current keys, past messages remain protected.

### Edge Case 5: Concurrent Sends (App Layer)

**Scenario:** User clicks send twice rapidly, or sends from multiple tabs.

**Risk:** Two encryptions read the same session state, both produce n=5, one overwrites the other's session update.

**App layer solution:**
```typescript
// useMessageQueue.ts - per-conversation queue
const queuesRef = useRef<Map<string, ConversationQueue>>(new Map());

// Sequential processing
while (queue.messages.length > 0) {
  const message = queue.messages[0];
  const { session: nextSession } = ratchetEncrypt(currentSession, ...);
  currentSession = nextSession;  // In-memory update
  await dbService.saveRatchetSession(nextSession);  // Persist
  // ... send tx
  queue.messages.shift();
}
```

**Critical:** The in-memory session cache (`sessionCacheRef`) must persist across `processQueue` invocations to prevent race conditions.

### Edge Case 6: Session Reset (Not Yet Implemented)

**Scenario:** Keys compromised, or session state corrupted. Need fresh start.

**Planned approach:**
1. Mark current session as `inactive_reset`
2. Initiate new handshake with fresh ephemeral
3. New session gets incremented `epoch`
4. Old `conversationId` moves to `previousConversationId` on Contact

**Why epoch matters:** Allows distinguishing messages from old vs new session during transition period.
⚠️ TRADEOFF: Messages sent by Bob after Alice lost state and before
       Alice reset are PERMANENTLY LOST from Alice's perspective.
       This is inherent to forward secrecy.

---

### State Machine Summary

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

## DoS Protection via Signatures

### The Problem

Without signatures, an attacker controls how much work you do:
```
Attacker posts: header = {dh: garbage, pn: 999999, n: 999999}
Victim reads header → derives ~1M skip keys → then AEAD fails
Cost: O(N) where attacker controls N
```

### The Solution

Ed25519 signatures are mandatory on all ratchet messages:
```
Payload = [version (1)] [signature (64)] [dh (32)] [pn (4)] [n (4)] [ciphertext (var)]
```

**Verification order:**
```typescript
// App layer MUST do this first
const sigValid = verifyMessageSignature(signature, header, ciphertext, contactSigningPubKey);
if (!sigValid) return; // O(1) rejection, no ratchet operations

// Only then touch ratchet state
const result = ratchetDecrypt(session, header, ciphertext);
```

**Cost comparison:**

| Attack | Without signatures | With signatures |
|--------|-------------------|-----------------|
| Garbage payload | O(N) skip key derivations | O(1) signature verify |
| Wrong sender | O(N) then AEAD fail | O(1) reject |
| Replay | Depends on n value | O(1) reject (wrong sig) |

---

## Binary Payload Format

```
Offset  Size  Field
──────────────────────────────────────────
0       1     Version (0x01)
1       64    Ed25519 signature
65      32    DH ratchet public key
97      4     pn (uint32 BE) - previous chain length
101     4     n (uint32 BE) - message number
105     var   Ciphertext (nonce + XSalsa20-Poly1305 output)
```

Minimum payload: 105 bytes + ciphertext.

---

## KDF Specifications

**Root key derivation (on DH ratchet step):**
```
KDF_RK(rk, dh_out) = HKDF-SHA256(ikm=dh_out, salt=rk, info="VerbethRatchet", len=64)
  → new_rk = output[0:32], chain_key = output[32:64]
```

**Chain key derivation (per message):**
```
KDF_CK(ck) = (HMAC-SHA256(ck, 0x02), HMAC-SHA256(ck, 0x01))
  → new_chain_key, message_key
```

**Message encryption:** XSalsa20-Poly1305 (NaCl secretbox)

---

## Summary: What Makes VerbEth Different

1. **Ephemeral-only initial secret** — No identity keys in DH means unconditional forward secrecy from message 0

2. **Trustless authentication** — `msg.sender` is a protocol guarantee; binding proofs tie keys to addresses cryptographically

3. **No prekey infrastructure** — Bob's ephemeral comes from his live response, not a pre-published bundle

4. **Burned slots, not rollbacks** — Failed sends consume their slot; receiver's skip keys handle gaps (matches Signal)

5. **Signatures for DoS protection** — Auth-before-ratchet prevents O(N) attacks from unauthenticated messages

6. **Session by conversation, not address** — `conversationId` from topics handles Safe/EOA correctly


