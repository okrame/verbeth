import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { dbService } from "../services/DbService.js";
import {
  CONTRACT_CREATION_BLOCK,
  INITIAL_SCAN_BLOCKS,
  MAX_RETRIES,
  MAX_RANGE_PROVIDER,
  CHUNK_SIZE,
  REAL_TIME_BUFFER,
  Contact,
  ProcessedEvent,
  MessageListenerResult,
  ListenerSyncStatus,
  PendingRange,
} from "../types.js";
import { collectEventsForRange } from "./listener/eventQuerySpecs.js";
import { createLogFetcher } from "./listener/logFetcher.js";
import { clampCursorToTip, planRanges } from "./listener/scanPlanner.js";
import {
  dequeueRetryableRanges,
  enqueueRanges,
  loadSyncState,
  saveSyncState,
  toSyncStatus,
} from "./listener/syncStateStore.js";

interface UseMessageListenerProps {
  readProvider: any;
  address: string | undefined;
  /** Safe address in fast mode, EOA in classic mode. Used for outbound confirmations. */
  emitterAddress: string | undefined;
  onEventsProcessed: (events: ProcessedEvent[]) => Promise<void>;
  /** When provided, uses watchBlockNumber (WS subscription) instead of setInterval polling. */
  viemClient?: any;
  verbethClient?: any;
}

const IDLE_SYNC_STATUS: ListenerSyncStatus = {
  mode: "idle",
  pendingRanges: 0,
  isComplete: false,
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown error");
}

export const useMessageListener = ({
  readProvider,
  address,
  emitterAddress,
  onEventsProcessed,
  viemClient,
  verbethClient,
}: UseMessageListenerProps): MessageListenerResult => {
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [canLoadMore, setCanLoadMore] = useState(true);
  const [syncProgress, setSyncProgress] = useState<{ current: number; total: number } | null>(null);
  const [syncStatus, setSyncStatus] = useState<ListenerSyncStatus>(IDLE_SYNC_STATUS);
  const [lastKnownBlock, setLastKnownBlock] = useState<number | null>(null);
  const [oldestScannedBlock, setOldestScannedBlock] = useState<number | null>(null);

  const lastKnownBlockRef = useRef<number | null>(null);
  const onEventsProcessedRef = useRef(onEventsProcessed);
  const isRealtimeScanRunningRef = useRef(false);
  const isBackfillWorkerRunningRef = useRef(false);
  const hasBootstrappedRef = useRef(false);

  onEventsProcessedRef.current = onEventsProcessed;

  const logFetcher = useMemo(() => {
    if (!readProvider) return null;
    return createLogFetcher({
      provider: readProvider,
      maxRetries: MAX_RETRIES,
      maxRangeProvider: MAX_RANGE_PROVIDER,
    });
  }, [readProvider]);

  const refreshSyncStatus = useCallback(async () => {
    if (!address) {
      setSyncStatus(IDLE_SYNC_STATUS);
      return;
    }
    const state = await loadSyncState(address);
    setSyncStatus(toSyncStatus(state));
  }, [address]);

  const getCurrentContacts = useCallback(async (): Promise<Contact[]> => {
    if (!address) return [];
    try {
      return await dbService.getAllContacts(address);
    } catch (error) {
      console.error("[verbeth] failed to load contacts:", error);
      return [];
    }
  }, [address]);

  const scanBlockRange = useCallback(
    async (fromBlock: number, toBlock: number): Promise<ProcessedEvent[]> => {
      if (!address || !logFetcher || fromBlock > toBlock) return [];

      const contacts = await getCurrentContacts();
      const pendingContacts = contacts.filter((contact) => contact.status === "handshake_sent");
      const activeTopics = await dbService.ratchet.getAllActiveInboundTopics(address);

      return collectEventsForRange({
        fromBlock,
        toBlock,
        context: {
          address,
          emitterAddress,
          activeTopics,
          pendingContacts,
        },
        getLogs: async (filter, rangeStart, rangeEnd) => {
          return logFetcher.getLogsForRange(filter, {
            fromBlock: rangeStart,
            toBlock: rangeEnd,
          });
        },
      });
    },
    [address, emitterAddress, getCurrentContacts, logFetcher]
  );

  const processRange = useCallback(
    async (fromBlock: number, toBlock: number): Promise<ProcessedEvent[]> => {
      const events = await scanBlockRange(fromBlock, toBlock);
      if (events.length > 0) {
        await onEventsProcessedRef.current(events);
      }
      return events;
    },
    [scanBlockRange]
  );

  const batchProcessRanges = useCallback(
    async (
      ranges: PendingRange[] | { fromBlock: number; toBlock: number }[],
      options?: { showProgress?: boolean; stopOnError?: boolean }
    ): Promise<ProcessedEvent[]> => {
      const { showProgress = false, stopOnError = false } = options ?? {};
      const allEvents: ProcessedEvent[] = [];
      const failedRanges: PendingRange[] = [];

      if (showProgress && ranges.length > 1) {
        setSyncProgress({ current: 0, total: ranges.length });
      }

      let completed = 0;
      for (const range of ranges) {
        try {
          const events = await processRange(range.fromBlock, range.toBlock);
          allEvents.push(...events);
        } catch (error) {
          console.error(
            `[verbeth] scan failed for range ${range.fromBlock}-${range.toBlock}:`,
            error
          );
          if (stopOnError) throw error;
          failedRanges.push({
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
            attempts: 1,
            nextRetryAt: Date.now() + 1_500,
            lastError: toErrorMessage(error),
          });
        }

        completed += 1;
        if (showProgress && ranges.length > 1) {
          setSyncProgress({ current: completed, total: ranges.length });
        }
      }

      setSyncProgress(null);

      if (failedRanges.length > 0 && address) {
        await enqueueRanges(address, failedRanges, "degraded");
        await refreshSyncStatus();
      }

      return allEvents;
    },
    [address, processRange, refreshSyncStatus]
  );

  const performInitialScan = useCallback(async () => {
    if (!readProvider || !address || !logFetcher) return;

    setIsInitialLoading(true);

    try {
      const currentBlock = Number(await readProvider.getBlockNumber());
      const initialScanComplete = !!(await dbService.getInitialScanComplete(address));
      const savedLastBlockRaw = await dbService.getLastKnownBlock(address);
      const savedOldestBlockRaw = await dbService.getOldestScannedBlock(address);
      const savedLastBlock =
        typeof savedLastBlockRaw === "number" ? savedLastBlockRaw : null;
      const savedOldestBlock =
        typeof savedOldestBlockRaw === "number" ? savedOldestBlockRaw : null;

      const fallbackOldest = Math.max(
        currentBlock - INITIAL_SCAN_BLOCKS,
        CONTRACT_CREATION_BLOCK
      );
      const effectiveOldest = savedOldestBlock ?? fallbackOldest;
      setOldestScannedBlock(effectiveOldest);
      setCanLoadMore(effectiveOldest > CONTRACT_CREATION_BLOCK);

      if (initialScanComplete) {
        let cursor = savedLastBlock;
        if (cursor === null) {
          cursor = fallbackOldest;
          console.warn("[verbeth] sync cursor missing, using fallback window cursor");
        }

        cursor = clampCursorToTip(cursor, currentBlock);

        if (cursor < currentBlock) {
          const catchUpRanges = planRanges(cursor + 1, currentBlock, CHUNK_SIZE);
          await batchProcessRanges(catchUpRanges, {
            showProgress: catchUpRanges.length > 1,
            stopOnError: false,
          });
        }

        setLastKnownBlock(currentBlock);
        lastKnownBlockRef.current = currentBlock;
        await dbService.setLastKnownBlock(address, currentBlock);
        const postState = await loadSyncState(address);
        if (postState.pendingRanges.length === 0) {
          await saveSyncState(address, {
            pendingRanges: [],
            status: "synced",
            targetTip: currentBlock,
            lastError: undefined,
          });
        } else {
          await saveSyncState(address, {
            targetTip: currentBlock,
          });
        }
        await refreshSyncStatus();
        return;
      }

      const startBlock = Math.max(
        currentBlock - INITIAL_SCAN_BLOCKS,
        CONTRACT_CREATION_BLOCK
      );
      const initialRanges = planRanges(startBlock, currentBlock, CHUNK_SIZE);

      await batchProcessRanges(initialRanges, {
        showProgress: initialRanges.length > 1,
        stopOnError: true,
      });

      setLastKnownBlock(currentBlock);
      lastKnownBlockRef.current = currentBlock;
      setOldestScannedBlock(startBlock);
      setCanLoadMore(startBlock > CONTRACT_CREATION_BLOCK);

      await dbService.setLastKnownBlock(address, currentBlock);
      await dbService.setOldestScannedBlock(address, startBlock);
      await dbService.setInitialScanComplete(address, true);
      await saveSyncState(address, {
        pendingRanges: [],
        status: "synced",
        targetTip: currentBlock,
        lastError: undefined,
      });
      await refreshSyncStatus();
    } catch (error) {
      console.error("[verbeth] scan failed during initial sync:", error);
      await saveSyncState(address, {
        status: "degraded",
        lastError: toErrorMessage(error),
      });
      await refreshSyncStatus();
    } finally {
      setIsInitialLoading(false);
    }
  }, [
    address,
    batchProcessRanges,
    logFetcher,
    readProvider,
    refreshSyncStatus,
  ]);

  const loadMoreHistory = useCallback(async () => {
    if (
      !readProvider ||
      !address ||
      isLoadingMore ||
      !canLoadMore ||
      oldestScannedBlock === null
    ) {
      return;
    }

    setIsLoadingMore(true);

    try {
      const endBlock = oldestScannedBlock - 1;
      if (endBlock < CONTRACT_CREATION_BLOCK) {
        setCanLoadMore(false);
        return;
      }

      const startBlock = Math.max(
        endBlock - INITIAL_SCAN_BLOCKS,
        CONTRACT_CREATION_BLOCK
      );
      const ranges = planRanges(startBlock, endBlock, CHUNK_SIZE);

      await batchProcessRanges(ranges, {
        showProgress: ranges.length > 1,
        stopOnError: false,
      });

      setOldestScannedBlock(startBlock);
      setCanLoadMore(startBlock > CONTRACT_CREATION_BLOCK);
      await dbService.setOldestScannedBlock(address, startBlock);
    } catch (error) {
      console.error("[verbeth] failed to load more history:", error);
    } finally {
      setIsLoadingMore(false);
      setSyncProgress(null);
    }
  }, [
    address,
    batchProcessRanges,
    canLoadMore,
    isLoadingMore,
    oldestScannedBlock,
    readProvider,
  ]);

  useEffect(() => {
    if (!address || !readProvider || !logFetcher) return;

    let disposed = false;

    const runBackfillWorker = async () => {
      if (disposed || isBackfillWorkerRunningRef.current) return;

      isBackfillWorkerRunningRef.current = true;

      try {
        const retryableRanges = await dequeueRetryableRanges(address, Date.now(), 1);
        if (retryableRanges.length === 0) {
          await refreshSyncStatus();
          return;
        }

        for (const range of retryableRanges) {
          try {
            await processRange(range.fromBlock, range.toBlock);
          } catch (error) {
            const attempts = range.attempts + 1;
            const retryDelay =
              Math.min(120_000, 1_500 * 2 ** Math.min(attempts, 6)) +
              Math.floor(Math.random() * 600);

            await enqueueRanges(
              address,
              [
                {
                  ...range,
                  attempts,
                  nextRetryAt: Date.now() + retryDelay,
                  lastError: toErrorMessage(error),
                },
              ],
              "degraded"
            );
          }
        }

        const state = await loadSyncState(address);
        if (state.pendingRanges.length === 0 && state.status !== "synced") {
          await saveSyncState(address, {
            status: "synced",
            lastError: undefined,
          });
        }

        await refreshSyncStatus();
      } finally {
        isBackfillWorkerRunningRef.current = false;
      }
    };

    void runBackfillWorker();
    const interval = setInterval(() => {
      void runBackfillWorker();
    }, 4_000);

    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [address, logFetcher, processRange, readProvider, refreshSyncStatus]);

  useEffect(() => {
    if (!readProvider || !address) return;

    const handleNewBlock = async (blockNumber: number) => {
      const currentLastKnown = lastKnownBlockRef.current;
      if (currentLastKnown === null) return;
      if (isRealtimeScanRunningRef.current) return;

      isRealtimeScanRunningRef.current = true;

      try {
        const readTip = Number(await readProvider.getBlockNumber());
        const maxSafeBlock = Math.min(blockNumber, readTip) - REAL_TIME_BUFFER;
        if (maxSafeBlock <= currentLastKnown) return;

        await processRange(currentLastKnown + 1, maxSafeBlock);

        setLastKnownBlock(maxSafeBlock);
        lastKnownBlockRef.current = maxSafeBlock;
        await dbService.setLastKnownBlock(address, maxSafeBlock);
      } catch (error) {
        console.error("[verbeth] real-time scan error:", error);
      } finally {
        isRealtimeScanRunningRef.current = false;
      }
    };

    if (viemClient) {
      const unwatch = viemClient.watchBlockNumber({
        onBlockNumber: (blockNumber: bigint) => {
          void handleNewBlock(Number(blockNumber));
        },
        emitOnBegin: false,
        pollingInterval: 4_000,
      });
      return unwatch;
    }

    const interval = setInterval(async () => {
      try {
        const currentBlock = Number(await readProvider.getBlockNumber());
        await handleNewBlock(currentBlock);
      } catch (error) {
        console.error("[verbeth] real-time scan error:", error);
      }
    }, 5_000);

    return () => clearInterval(interval);
  }, [address, processRange, readProvider, viemClient]);

  useEffect(() => {
    hasBootstrappedRef.current = false;
    setIsInitialLoading(false);
    setIsLoadingMore(false);
    setCanLoadMore(true);
    setSyncProgress(null);
    setSyncStatus(IDLE_SYNC_STATUS);
    setLastKnownBlock(null);
    lastKnownBlockRef.current = null;
    setOldestScannedBlock(null);

    if (!address) return;

    void (async () => {
      const persisted = await loadSyncState(address);
      setSyncStatus(toSyncStatus(persisted));
    })();
  }, [address]);

  useEffect(() => {
    if (!readProvider || !address || !logFetcher || !verbethClient || hasBootstrappedRef.current) {
      return;
    }

    hasBootstrappedRef.current = true;
    void performInitialScan();
  }, [address, logFetcher, performInitialScan, readProvider, verbethClient]);

  return {
    isInitialLoading,
    isLoadingMore,
    canLoadMore,
    syncProgress,
    syncStatus,
    loadMoreHistory,
    lastKnownBlock,
    oldestScannedBlock,
  };
};
