# Topic Ratcheting Mechanism

This document explains how Verbeth synchronizes topic rotation with the Double Ratchet DH steps, providing forward secrecy at the network layer.

## Core Principle

Topics rotate alongside DH ratchet steps. Each new DH shared secret deterministically derives new topics via HKDF, ensuring that compromising a topic reveals nothing about past or future topics.

```
DH Ratchet Step → New DH Shared Secret → deriveTopicFromDH() → New Topics
```

---

## SDK Layer

### Session State (RatchetSession)

| Field | Purpose |
|-------|---------|
| `currentTopicOutbound` | Topic for sending messages now |
| `currentTopicInbound` | Topic for receiving messages now |
| `nextTopicOutbound/Inbound` | Pre-computed topics for incoming DH ratchet |
| `previousTopicInbound` | Grace period topic (5 min) |
| `previousTopicExpiry` | Timestamp when previous topic expires |
| `topicEpoch` | Counter for debugging |

### Topic Derivation (`kdf.ts`)

```typescript
deriveTopicFromDH(dhSharedSecret, direction, salt) → bytes32 topic
```

Direction labels (`'outbound'`/`'inbound'`) ensure asymmetric topics. The sender's outbound is the receiver's inbound.

### On Encrypt (`encrypt.ts`)

Uses `session.currentTopicOutbound`. No topic changes on send—topics only rotate on DH ratchet (when receiving).

### On Decrypt (`decrypt.ts` → `dhRatchetStep`)

When a message carries a new DH public key:

1. Compute `dhReceive = DH(mySecret, theirNewPub)`
2. Derive new receiving chain from `dhReceive`
3. Generate new DH keypair for response
4. Compute `dhSend = DH(newSecret, theirNewPub)`
5. **Derive topics from `dhReceive`** (labels swapped since we're receiver):
   - `newTopicOut = deriveTopicFromDH(dhReceive, 'inbound', salt)`
   - `newTopicIn = deriveTopicFromDH(dhReceive, 'outbound', salt)`
6. **Pre-compute next topics from `dhSend`** (for when peer ratchets):
   - `nextTopicOut = deriveTopicFromDH(dhSend, 'outbound', salt)`
   - `nextTopicIn = deriveTopicFromDH(dhSend, 'inbound', salt)`
7. Archive current inbound as `previousTopicInbound` with 5-min expiry

---

## App Layer

### Sending (`useMessageQueue.ts`)

```typescript
const { topic: ratchetedTopic } = ratchetEncrypt(session, plaintext, signingKey);
await executor.sendMessage(payload, ratchetedTopic, timestamp, nonce);
```

The topic comes from `EncryptResult.topic`, which is `session.currentTopicOutbound`.

### Receiving (`EventProcessorService.ts`)

1. **Multi-topic lookup**: `getRatchetSessionByAnyInboundTopic(topic)` queries:
   - `currentTopicInbound` (primary)
   - `nextTopicInbound` (pre-computed for incoming ratchet)
   - `previousTopicInbound` (if within grace period)

2. **Topic promotion**: If message arrives on `nextTopicInbound`:
   ```typescript
   previousTopicInbound = currentTopicInbound;
   previousTopicExpiry = now + 5min;
   currentTopicInbound = nextTopicInbound;
   currentTopicOutbound = nextTopicOutbound;
   nextTopicInbound = undefined;
   topicEpoch++;
   ```

3. **Decryption**: `ratchetDecrypt()` may trigger another DH ratchet step internally, updating topics again.

### Event Filtering (`useMessageListener.ts`)

```typescript
const activeTopics = await dbService.getAllActiveInboundTopics(address);
// Returns: current + next + non-expired previous topics for all sessions
```

Blockchain log queries filter by all active topics to catch messages during transitions.

### Database Indexing (`schema.ts`)

```typescript
ratchetSessions: "conversationId, ..., currentTopicInbound, nextTopicInbound, previousTopicInbound, ..."
```

Enables O(1) lookups by any topic variant.

---

## Scenario Handling

| Scenario | Mechanism |
|----------|-----------|
| **Sequential messages** | Same topic, no ratchet needed |
| **Peer ratchets** | Message on `nextTopicInbound` → promote topics |
| **Late message on old topic** | `previousTopicInbound` with grace period |
| **Out-of-order within epoch** | Skip keys (topic unchanged) |
| **Session reset** | New handshake → fresh epoch 0 topics |

---

## Developer Conventions

1. **Session persistence**: Always save after `ratchetDecrypt()` returns—topics may have changed.

2. **Cache by conversationId, not topic**: Topics change; `conversationId` is stable.

3. **Immediate session commit on encrypt**: Persist before sending tx (two-phase commit protects against slot loss).

4. **Contact sync**: After processing, update `contact.topicOutbound/Inbound` from session state.

5. **Grace period**: 5 minutes (`TOPIC_TRANSITION_WINDOW_MS`). Don't rely on longer windows.

6. **Never filter by single topic**: Always use `getAllActiveInboundTopics()` for event queries.

---

## Typical Flow

```
Alice (Initiator)                          Bob (Responder)
─────────────────                          ────────────────
Epoch 0: handshake topics                  Epoch 0: handshake topics

Send msg on topicOut₀ ──────────────────► Receive on topicIn₀
                                          DH ratchet → Epoch 1
                                          (next topics pre-computed)

                    ◄────────────────────  Send msg on topicOut₁
Receive on nextTopicIn                     
Promote → Epoch 1                          
DH ratchet → pre-compute Epoch 2           

Send msg on topicOut₁ ──────────────────► Receive on topicIn₁
                                          ...
```

Each direction independently advances its topic epoch when receiving a new DH public key.