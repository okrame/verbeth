# Message Listener Architecture

## Overview

`useMessageListener` syncs on-chain Verbeth events into the local IndexedDB.
It operates in three phases: Bootstrap, Real-time, and Backfill.

## Bootstrap (automatic on connect)

```
    ┌──────────────────────────────────┐
    │  useEffect (bootstrap trigger)   │
    │  fires when:                     │
    │    readProvider + address +       │
    │    verbethClient are ready       │
    └──────────────┬───────────────────┘
                   │
                   v
    ┌──────────────────────────────────┐
    │  performInitialScan()            │
    │                                  │
    │  Read from IndexedDB:            │
    │    - initialScanComplete?        │
    │    - savedLastBlock              │
    │    - savedOldestBlock            │
    └──────────┬───────────────────────┘
               │
        ┌──────┴──────┐
        │             │
   first visit   returning user
        │             │
        v             v
    ┌────────┐   ┌─────────────────────────────────┐
    │ Scan   │   │ Catch-up:                       │
    │ last   │   │ scan savedLastBlock+1 → current │
    │ N blks │   └─────────────────────────────────┘
    │ (back  │   
    │  from  │   
    │  tip)  │   
    └────────┘   
        │             │
        v             v
    ┌──────────────────────────────────┐
    │  Save to IndexedDB:              │
    │    lastKnownBlock = currentBlock │
    │    initialScanComplete = true    │
    └──────────────────────────────────┘
```

## Real-time (runs continuously after bootstrap)

```
    ┌─────────────────────────┐
    │ WebSocket (Alchemy WS)  │      ┌───────────────────────┐
    │ or HTTP fallback poll   │      │ Fallback: poll every   │
    │                         │      │ 5s if no viemClient    │
    │ watchBlockNumber()      │      └───────┬───────────────┘
    │ emits new block numbers │              │
    └────────────┬────────────┘              │
                 │                           │
                 v                           v
    ┌──────────────────────────────────────────┐
    │  latestBlockRef.current = blockNumber    │
    │  (just stores it, no RPC call)           │
    └──────────────────┬───────────────────────┘
                       │
              every 4s (setInterval)
                       │
                       v
    ┌──────────────────────────────────────────┐
    │  drainAccumulated()                      │
    │                                          │
    │  1. Read latestBlockRef (from WS)        │
    │  2. Read publicLatest (1 RPC call)       │
    │  3. maxSafeBlock = min(ws, public) - 2   │
    │  4. If maxSafeBlock > lastKnownBlock:    │
    │       scanBlockRange(lastKnown+1, max)   │
    │  5. Update lastKnownBlock in DB          │
    └──────────────────────────────────────────┘
```

## Backfill (user-triggered only)

```
    ┌─────────────────────────────────────────┐
    │  User clicks "Load More History"        │
    │                                         │
    │  loadMoreHistory()                      │
    │                                         │
    │  Scans BACKWARDS:                       │
    │    oldestScannedBlock-1 → older blocks  │
    │    (toward CONTRACT_CREATION_BLOCK)     │
    │                                         │
    │  Updates oldestScannedBlock in DB       │
    │  Sets canLoadMore = false when reached  │
    │    CONTRACT_CREATION_BLOCK              │
    └─────────────────────────────────────────┘
```

## What scanBlockRange() queries (per chunk)

```
    ┌──────────────────────────────────────────────────┐
    │  scanBlockRange(fromBlock, toBlock)               │
    │                                                  │
    │  Up to 4 getLogs queries per chunk:               │
    │                                                  │
    │  1. Handshake        (always)                    │
    │     topic[0] = Handshake event sig               │
    │     topic[1] = recipientHash(myAddress)          │
    │                                                  │
    │  2. HandshakeResponse (only if pending contacts) │
    │     topic[0] = HandshakeResponse event sig       │
    │     matched by trial ECDH over pending contacts  │
    │                                                  │
    │  3. Inbound messages (only if active topics)     │
    │     topic[0] = MessageSent event sig             │
    │     topic[2] = [active inbound ratchet topics]   │
    │                                                  │
    │  4. Outbound confirm (only if has contacts)      │
    │     topic[0] = MessageSent event sig             │
    │     topic[1] = senderTopic(myAddress)            │
    └──────────────────────────────────────────────────┘
```

## IndexedDB sync state (per address)

```
    Key                         Value           Purpose
    ─────────────────────────   ──────────────  ──────────────────────
    lastKnownBlock_0xABC...     28401234        Phase 1 catch-up start
    oldestScannedBlock_0xABC... 28390000        Phase 3 backfill edge
    initialScanComplete_0xABC.. true            Skip first-time scan
```
