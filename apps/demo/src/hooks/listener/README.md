## Event Listener Architecture

The listener recovers every on-chain event for the connected account and keeps up with new blocks in real time. It is split into four independent paths that never block each other.

```plaintext
                          Alchemy WS
                        (block notify)
                              |
                              v
                     +------------------+
                     |  handleNewBlock  |
                     |                  |
                     |  clamp to the    |
  polling fallback   |  read provider   |
  (if no WS) ------->|  tip so we never |
                     |  scan past what  |
                     |  getLogs can see  |
                     +--------+---------+
                              |
              scan [lastKnown+1 .. maxSafe]
                              |
                              v
+----------------+   +----------------+   +--------------------+
|  Bootstrap     |   |  Real-time     |   |  Backfill worker   |
|                |   |                |   |                    |
|  first login:  |   |  moves cursor  |   |  retries failed    |
|  scan recent   |   |  forward each  |   |  ranges from       |
|  window        |   |  block         |   |  syncState with    |
|                |   |                |   |  exp. backoff      |
+-------+--------+   +-------+--------+   +---------+----------+
        |                     |                      |
        |    catch-up on      |                      |
        |    reconnect:       |                      |
        |    only marks       |                      |
        |    "synced" if no   |                      |
        |    failed ranges    |                      |
        |    remain           |                      |
        v                     v                      v
   +---------------------------------------------------+
   |              processRange / getLogs                |
   |                                                    |
   |             reads from public HTTP node            |
   +---------------------------------------------------+
                              |
                              v
                  onEventsProcessed callback
                              |
                              v
                    dedup by receipt key
              event:<owner>:<type>:<txHash>-<logIndex>

                              |
                              v
                  +------------------------+
                  |  loadMoreHistory       |
                  |  (user scrolls back)   |
                  |  scans older ranges    |
                  |  on demand             |
                  +------------------------+
```

### How the pieces fit together

**Bootstrap** runs once per account. On first login it scans a recent window of blocks and persists the cursor boundaries. On subsequent logins it catches up from the saved cursor to the current tip. If any chunk fails during catch-up, the failed range stays in `syncState` so the backfill worker can retry it later. The sync state is only marked "synced" when no pending ranges remain.

**Real-time scanning** is driven by block notifications. When Alchemy WS is available, `watchBlockNumber` triggers the scan. Otherwise a polling interval checks the read provider every 5 seconds. Either way, the scan ceiling is clamped to what the read provider has actually indexed. This prevents the cursor from advancing past blocks the HTTP node has not served yet, which could cause silent message loss when the WS tip runs ahead.

**Backfill worker** wakes up every 4 seconds and pulls one retryable range at a time from the persisted queue. Retries use exponential backoff with jitter (1.5s base, 2 min cap). Once the queue drains, status flips back to "synced". Single-flight execution keeps RPC usage friendly.

**Load more** lets the user scroll backward into older history. It extends the scanned window toward the contract creation block in `INITIAL_SCAN_BLOCKS`-sized chunks.

### RPC split

Two providers serve different roles:

- **Alchemy WS** -- block-head notifications only. Fast, low latency, no CORS issues.
- **Public HTTP** -- all data reads (`getLogs`, `getBlockNumber`, balances). The real-time scan asks this provider for its tip before scanning, so the cursor never outruns what this node can actually return.

### Idempotency

Every processed event is tracked by a persistent receipt key (`event:<owner>:<type>:<txHash>-<logIndex>`). Retries and overlapping scans are safe because the dedup layer silently drops anything already seen.

### Modules

- `useMessageListener.ts` -- orchestration (bootstrap, real-time, worker, UI state)
- `listener/scanPlanner.ts` -- range planning and cursor clamping
- `listener/logFetcher.ts` -- `getLogs` with retries and automatic range splitting
- `listener/eventQuerySpecs.ts` -- event filters and log-to-ProcessedEvent mapping
- `listener/syncStateStore.ts` -- persisted sync state helpers (load, save, enqueue, dequeue)
- `listener/healthScore.ts` -- pure health scoring functions