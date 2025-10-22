## Event listening logic

```plaintext
[ INITIAL SCAN (last X blocks) ]  →  [ REAL-TIME SCAN ONLY ]
            |                                |
         (loadMore)                    (new blocks)
            |
 [ SCAN OTHER OLDER BLOCKS ]
```

The listener maintains a rolling view of on-chain message events for the connected account. It performs three types of scans depending on context.

### 1. Initial scan

* Runs **only once per account** (no prior scan found).
* Reads the last `INITIAL_SCAN_BLOCKS` (default: 1000).
* Persists in DB:

  ```ts
  lastKnownBlock = currentBlock
  oldestScannedBlock = startBlock
  initialScanComplete[address] = true
  ```
* Then switches to real-time mode

### 2. Real-time scan

* Starts automatically on every subsequent login.
* Restores persisted state and catches up from where it left off:

  ```text
  lastKnownBlock + 1 → currentBlock - REAL_TIME_BUFFER
  ```

  (buffer ≈ 3 blocks behind the tip to avoid public RPC inconsistencies)
* Polls every few seconds
* With enough time, fetches any messages received while the user was offline
* After that, it continues polling forward in real time with the same buffer

### 3. “Load more history”

* It is an optional action triggered by the user
* Extends history further back in time:

  ```text
  oldestScannedBlock - 1 → older blocks
  ```
* Updates `oldestScannedBlock` in the DB
* Useful only for exploring very old messages

---


> [!NOTE]
> Opening a contact does not cause new chain reads. The listener always scans globally

