---
sidebar_position: 5
title: Message Store
---

# Message Store

The SDK does not prescribe a storage backend. It defines two interfaces that applications implement to connect `VerbethClient` to whatever persistence layer they choose. This page explains what those interfaces require and where the boundary sits between SDK logic and app logic.

## SessionStore

The `SessionStore` interface (`client/types.ts`) has three methods.

```typescript
interface SessionStore {
  get(conversationId: string): Promise<RatchetSession | null>;
  getByInboundTopic(topic: string): Promise<RatchetSession | null>;
  save(session: RatchetSession): Promise<void>;
}
```

`get()` retrieves a session by its primary key, which is the `conversationId` (a `keccak256` hash of the sorted topic pair).

`getByInboundTopic()` is the critical query. When an on-chain message event arrives, the SDK knows only the topic. It needs to find the corresponding session. This lookup is the app's responsibility. The SDK's internal `SessionManager` (`client/SessionManager.ts`) provides caching and topic promotion logic, but it delegates the actual database query to this method. 

The store must be able to find a session where the given topic matches any of `currentTopicInbound`, `nextTopicInbound`, or `previousTopicInbound`. This typically means indexing the session table on all three fields.

`save()` persists the session state after every encrypt or decrypt operation. Failing to persist means the ratchet can roll back to stale state, which breaks forward secrecy and can create duplicate message keys.

## PendingStore

The `PendingStore` interface (`client/types.ts`) manages the lifecycle of outbound messages.

```typescript
interface PendingStore {
  save(pending: PendingMessage): Promise<void>;
  get(id: string): Promise<PendingMessage | null>;
  getByTxHash(txHash: string): Promise<PendingMessage | null>;
  updateStatus(id: string, status: PendingStatus, txHash?: string): Promise<void>;
  delete(id: string): Promise<void>;
  getByConversation(conversationId: string): Promise<PendingMessage[]>;
}
```

A `PendingMessage` moves through two active states: `preparing` (created before tx submission) and `submitted` (tx broadcast, txHash known). On confirmation the record is deleted, so there is no persistent `confirmed` state. On failure, `markFailed()` handles submit-time errors (tx never broadcast), while `revertTx()` handles post-broadcast reverts, so both remove the pending record. The `getByTxHash` index allows matching on-chain events back to pending records. See [VerbethClient](./verbeth-client.md) for the two-phase commit pattern that uses this store.

## Serialization

`RatchetSession` contains binary fields: `rootKey`, `dhMySecretKey`, `dhMyPublicKey`, `dhTheirPublicKey`, `sendingChainKey`, `receivingChainKey`, and the `messageKey` inside each `SkippedKey` entry. These are all `Uint8Array` values that most storage backends cannot persist directly.

Applications must handle the conversion between binary arrays and whatever format their database supports. Common approaches include base64 encoding for IndexedDB, hex encoding for SQL, or binary columns where available. The important thing is that the round-trip is lossless and that sensitive fields (root key, chain keys, DH secret keys, message keys) are treated with the same care as any cryptographic secret.


## Ephemeral state

Some state lives outside the two store interfaces and requires separate attention.

**Pending handshakes.** Between sending a handshake and receiving its response, the ephemeral secret key and the KEM secret key must be stored somewhere. The SDK returns them from `sendHandshake()` and expects them back when `createInitiatorSession()` or `createInitiatorSessionFromHsr()` is called. The app is responsible for persisting these across sessions. In an app build with Verbeth, they live in the `pendingHandshakes` table alongside the contact address and timestamp.

**Session cache.** `SessionManager` maintains an in-memory `Map<string, RatchetSession>` that avoids repeated database reads for the same session. The cache is invalidated when `invalidateSessionCache()` is called, or cleared entirely with `clearSessionCache()`. This cache is ephemeral and rebuilt on demand.

**Topic transition windows.** The `previousTopicInbound` and its expiry timestamp are part of the persisted `RatchetSession`, not ephemeral. But the decision to listen on that topic is made by the `SessionManager` during topic lookup. The store just needs to return sessions where any of the three topic fields match.
