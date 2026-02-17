import { useState, useEffect, useRef, useCallback } from "react";
import { AbiCoder, getBytes, keccak256, toUtf8Bytes } from "ethers";
import { matchHsrToContact, type PendingContactEntry } from "@verbeth/sdk";
import { dbService } from "../services/DbService.js";
import { planRanges, ScanFailedError, safeGetLogs } from "../services/scanEngine.js";
import {
  CONTRACT_CREATION_BLOCK,
  INITIAL_SCAN_BLOCKS,
  CHUNK_SIZE,
  REAL_TIME_BUFFER,
  BACKFILL_COOLDOWN_MS,
  ACCUMULATION_INTERVAL_MS,
  FALLBACK_POLL_INTERVAL_MS,
  EVENT_SIGNATURES,
  VERBETH_SINGLETON_ADDR,
  RETRY_DELAYS,
  MAX_FAILED_RETRIES,
  type Contact,
  type ProcessedEvent,
  type MessageListenerResult,
  type SyncProgress,
  type FailedRange,
} from "../types.js";

/* ─────────────────────────── Props / Return ──────────────────────────── */

interface UseMessageListenerProps {
  readProvider: any;
  address: string | undefined;
  emitterAddress: string | undefined;
  onEventsProcessed: (events: ProcessedEvent[]) => Promise<void>;
  viemClient?: any;
  verbethClient?: any;
}

/* ──────────────────────── Helpers (inline, React-adjacent) ────────────────────────── */

function userRecipientHash(address: string): string {
  return keccak256(toUtf8Bytes(`contact:${address.toLowerCase()}`));
}

function toLogIndex(log: any): number {
  const value = typeof log.logIndex !== "undefined" ? log.logIndex : log.index;
  return Number(value ?? 0);
}

function findMatchingContact(log: any, pendingContacts: Contact[]): Contact | null {
  const inResponseTo = log.topics[1] as `0x${string}`;
  const abiCoder = new AbiCoder();
  const [responderEphemeralRBytes, ciphertextBytes] = abiCoder.decode(
    ["bytes32", "bytes"],
    log.data
  );
  const responderEphemeralR = getBytes(responderEphemeralRBytes);
  const encryptedPayload = new TextDecoder().decode(getBytes(ciphertextBytes));

  const entries: PendingContactEntry[] = pendingContacts
    .filter(
      (c): c is Contact & { handshakeEphemeralSecret: string; handshakeKemSecret: string } =>
        !!c.handshakeEphemeralSecret && !!c.handshakeKemSecret
    )
    .map((c) => ({
      address: c.address,
      handshakeEphemeralSecret: getBytes(c.handshakeEphemeralSecret),
      kemSecretKey: getBytes(c.handshakeKemSecret),
    }));

  const matchedAddress = matchHsrToContact(entries, inResponseTo, responderEphemeralR, encryptedPayload);
  if (!matchedAddress) return null;
  return pendingContacts.find((c) => c.address.toLowerCase() === matchedAddress.toLowerCase()) ?? null;
}

/* ═══════════════════════════ HOOK ═══════════════════════════ */

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
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [lastKnownBlock, setLastKnownBlock] = useState<number | null>(null);
  const [oldestScannedBlock, setOldestScannedBlock] = useState<number | null>(null);
  const [backfillCooldown, setBackfillCooldown] = useState(false);
  const [oldestScannedDate, setOldestScannedDate] = useState<Date | null>(null);

  const lastKnownBlockRef = useRef<number | null>(null);
  const blockTimestampCache = useRef(new Map<number, Date>());
  const latestBlockRef = useRef<number | null>(null);
  const onEventsProcessedRef = useRef(onEventsProcessed);
  const isScanningRef = useRef(false);
  const hasBootstrappedRef = useRef(false);
  const processedLogs = useRef(new Set<string>());
  const lastBackfillAtRef = useRef(0);
  const failedRangesRef = useRef<FailedRange[]>([]);
  const droppedChunksRef = useRef(0);

  onEventsProcessedRef.current = onEventsProcessed;

  /* ───────────── scanBlockRange — 4 queries, smart skipping ────────────── */

  const scanBlockRange = useCallback(
    async (fromBlock: number, toBlock: number, opts?: { handshakesOnly?: boolean }): Promise<ProcessedEvent[]> => {
      if (!address || !readProvider || fromBlock > toBlock) return [];
      const handshakesOnly = opts?.handshakesOnly ?? false;

      const contacts = await dbService.getAllContacts(address);
      const pendingContacts = contacts.filter((c) => c.status === "handshake_sent");
      const activeTopics = await dbService.ratchet.getAllActiveInboundTopics(address);

      const events: ProcessedEvent[] = [];

      const addEvent = (
        log: any,
        eventType: "handshake" | "handshake_response" | "message",
        matchedContactAddress?: string
      ) => {
        const txHash = log.transactionHash as string;
        const logIndex = toLogIndex(log);
        const logKey = `${txHash}-${logIndex}`;
        const dedupKey = `${eventType}:${logKey}`;
        if (processedLogs.current.has(dedupKey)) return;
        processedLogs.current.add(dedupKey);
        events.push({
          logKey,
          eventType,
          rawLog: log,
          txHash,
          logIndex,
          blockNumber: Number(log.blockNumber ?? 0),
          timestamp: Date.now(),
          matchedContactAddress,
        });
      };

      // 1) Inbound handshakes (always)
      const hsLogs = await safeGetLogs(readProvider, {
        address: VERBETH_SINGLETON_ADDR,
        topics: [EVENT_SIGNATURES.Handshake, userRecipientHash(address)],
      }, fromBlock, toBlock);
      for (const log of hsLogs) addEvent(log, "handshake");

      // 2) Handshake responses (only if pending contacts)
      if (pendingContacts.length > 0) {
        const hsrLogs = await safeGetLogs(readProvider, {
          address: VERBETH_SINGLETON_ADDR,
          topics: [EVENT_SIGNATURES.HandshakeResponse],
        }, fromBlock, toBlock);
        for (const log of hsrLogs) {
          const match = findMatchingContact(log, pendingContacts);
          if (match) addEvent(log, "handshake_response", match.address);
        }
      }

      // 3) Inbound messages (only if active topics) — skip in handshakesOnly mode
      if (!handshakesOnly && activeTopics.length > 0) {
        const msgLogs = await safeGetLogs(readProvider, {
          address: VERBETH_SINGLETON_ADDR,
          topics: [EVENT_SIGNATURES.MessageSent, null, activeTopics],
        }, fromBlock, toBlock);
        for (const log of msgLogs) addEvent(log, "message");
      }

      // 4) Outbound confirmation (skip for fresh users with no contacts) — skip in handshakesOnly mode
      if (!handshakesOnly && contacts.length > 0) {
        const emitter = emitterAddress ?? address;
        const senderTopic = "0x000000000000000000000000" + emitter.slice(2).toLowerCase();
        const outLogs = await safeGetLogs(readProvider, {
          address: VERBETH_SINGLETON_ADDR,
          topics: [EVENT_SIGNATURES.MessageSent, senderTopic],
        }, fromBlock, toBlock);
        for (const log of outLogs) addEvent(log, "message");
      }

      events.sort((a, b) => (a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex));
      return events;
    },
    [address, emitterAddress, readProvider]
  );

  const processRange = useCallback(
    async (fromBlock: number, toBlock: number, opts?: { handshakesOnly?: boolean }) => {
      const events = await scanBlockRange(fromBlock, toBlock, opts);
      if (events.length > 0) await onEventsProcessedRef.current(events);
      return events;
    },
    [scanBlockRange]
  );

  /* ──────────── Safe processRange that catches failures ──────────── */

  const safeProcessRange = useCallback(
    async (fromBlock: number, toBlock: number, opts?: { handshakesOnly?: boolean }) => {
      try {
        await processRange(fromBlock, toBlock, opts);
      } catch (error) {
        if (error instanceof ScanFailedError) {
          failedRangesRef.current.push({
            fromBlock: error.fromBlock,
            toBlock: error.toBlock,
            attempts: 1,
            nextRetryAt: Date.now() + RETRY_DELAYS[0],
          });
        }
        console.error(`[verbeth] chunk failed ${fromBlock}-${toBlock}:`, error);
      }
    },
    [processRange]
  );

  /* ───────────────── Phase 1 — Bootstrap ─────────────────── */

  const performInitialScan = useCallback(async () => {
    if (!readProvider || !address) return;

    setIsInitialLoading(true);

    try {
      const currentBlock = Number(await readProvider.getBlockNumber());
      const initialScanComplete = !!(await dbService.getInitialScanComplete(address));
      const savedLastBlockRaw = await dbService.getLastKnownBlock(address);
      const savedOldestBlockRaw = await dbService.getOldestScannedBlock(address);
      const savedLastBlock = typeof savedLastBlockRaw === "number" ? savedLastBlockRaw : null;
      const savedOldestBlock = typeof savedOldestBlockRaw === "number" ? savedOldestBlockRaw : null;

      const fallbackOldest = Math.max(currentBlock - INITIAL_SCAN_BLOCKS, CONTRACT_CREATION_BLOCK);
      const effectiveOldest = savedOldestBlock ?? fallbackOldest;
      setOldestScannedBlock(effectiveOldest);
      setCanLoadMore(effectiveOldest > CONTRACT_CREATION_BLOCK);

      if (initialScanComplete) {
        // Returning user — catch up from savedLastBlock to tip
        let cursor = savedLastBlock ?? fallbackOldest;
        cursor = Math.max(0, Math.min(cursor, currentBlock));

        const gap = currentBlock - cursor;
        console.log(`[verbeth] catch-up: cursor=${cursor} current=${currentBlock} gap=${gap}`);

        if (cursor < currentBlock) {
          const totalBlocks = currentBlock - cursor;
          const catchUpRanges = planRanges(cursor + 1, currentBlock, CHUNK_SIZE);
          let blocksProcessed = 0;

          const showProgress = catchUpRanges.length > 1;
          if (showProgress) {
            setSyncProgress({ current: 0, total: totalBlocks, phase: "catch-up", failedChunks: 0 });
          }

          for (const range of catchUpRanges) {
            await safeProcessRange(range.fromBlock, range.toBlock);
            blocksProcessed += range.toBlock - range.fromBlock + 1;
            if (showProgress) {
              setSyncProgress({
                current: blocksProcessed,
                total: totalBlocks,
                phase: "catch-up",
                failedChunks: failedRangesRef.current.length,
              });
            }
          }
          setSyncProgress(null);
        }

        setLastKnownBlock(currentBlock);
        lastKnownBlockRef.current = currentBlock;
        await dbService.setLastKnownBlock(address, currentBlock);
        return;
      }

      // Fresh user — scan backward from tip
      const startBlock = Math.max(currentBlock - INITIAL_SCAN_BLOCKS, CONTRACT_CREATION_BLOCK);
      const initialRanges = planRanges(startBlock, currentBlock, CHUNK_SIZE);
      const totalBlocks = currentBlock - startBlock;

      let blocksProcessed = 0;
      if (initialRanges.length > 1) {
        setSyncProgress({ current: 0, total: totalBlocks, phase: "catch-up", failedChunks: 0 });
      }
      for (const range of initialRanges) {
        await safeProcessRange(range.fromBlock, range.toBlock);
        blocksProcessed += range.toBlock - range.fromBlock + 1;
        if (initialRanges.length > 1) {
          setSyncProgress({
            current: blocksProcessed,
            total: totalBlocks,
            phase: "catch-up",
            failedChunks: failedRangesRef.current.length,
          });
        }
      }
      setSyncProgress(null);

      setLastKnownBlock(currentBlock);
      lastKnownBlockRef.current = currentBlock;
      setOldestScannedBlock(startBlock);
      setCanLoadMore(startBlock > CONTRACT_CREATION_BLOCK);

      await dbService.setLastKnownBlock(address, currentBlock);
      await dbService.setOldestScannedBlock(address, startBlock);
      await dbService.setInitialScanComplete(address, true);
    } catch (error) {
      console.error("[verbeth] scan failed during initial sync:", error);
    } finally {
      setIsInitialLoading(false);
    }
  }, [address, safeProcessRange, readProvider]);

  /* ───────────────── Phase 3 — Backfill (user-triggered) ────────────── */

  const loadMoreHistory = useCallback(async () => {
    if (
      !readProvider ||
      !address ||
      isLoadingMore ||
      !canLoadMore ||
      oldestScannedBlock === null
    ) return;

    // Cooldown guard
    if (Date.now() - lastBackfillAtRef.current < BACKFILL_COOLDOWN_MS) return;

    setIsLoadingMore(true);
    setBackfillCooldown(true);

    try {
      const endBlock = oldestScannedBlock - 1;
      if (endBlock < CONTRACT_CREATION_BLOCK) {
        setCanLoadMore(false);
        return;
      }

      const startBlock = Math.max(endBlock - INITIAL_SCAN_BLOCKS, CONTRACT_CREATION_BLOCK);
      const ranges = planRanges(startBlock, endBlock, CHUNK_SIZE);
      const totalBlocks = endBlock - startBlock + 1;

      let blocksProcessed = 0;
      if (ranges.length > 1) {
        setSyncProgress({ current: 0, total: totalBlocks, phase: "backfill", failedChunks: failedRangesRef.current.length });
      }
      for (const range of ranges) {
        await safeProcessRange(range.fromBlock, range.toBlock, { handshakesOnly: true });
        blocksProcessed += range.toBlock - range.fromBlock + 1;
        if (ranges.length > 1) {
          setSyncProgress({
            current: blocksProcessed,
            total: totalBlocks,
            phase: "backfill",
            failedChunks: failedRangesRef.current.length,
          });
        }
      }
      setSyncProgress(null);

      setOldestScannedBlock(startBlock);
      setCanLoadMore(startBlock > CONTRACT_CREATION_BLOCK);
      await dbService.setOldestScannedBlock(address, startBlock);
      lastBackfillAtRef.current = Date.now();
    } catch (error) {
      console.error("[verbeth] failed to load more history:", error);
    } finally {
      setIsLoadingMore(false);
      setSyncProgress(null);
      setTimeout(() => setBackfillCooldown(false), BACKFILL_COOLDOWN_MS);
    }
  }, [address, canLoadMore, isLoadingMore, oldestScannedBlock, safeProcessRange, readProvider]);

  /* ──────────────── Reset state on address change ──────────────── */

  useEffect(() => {
    hasBootstrappedRef.current = false;
    setIsInitialLoading(false);
    setIsLoadingMore(false);
    setCanLoadMore(true);
    setSyncProgress(null);
    setLastKnownBlock(null);
    lastKnownBlockRef.current = null;
    latestBlockRef.current = null;
    setOldestScannedBlock(null);
    setBackfillCooldown(false);
    setOldestScannedDate(null);
    processedLogs.current.clear();
    blockTimestampCache.current.clear();
    failedRangesRef.current = [];
    droppedChunksRef.current = 0;
  }, [address]);

  /* ──────────── Oldest scanned date estimation ──────────── */

  useEffect(() => {
    if (!readProvider || oldestScannedBlock === null) return;

    const cached = blockTimestampCache.current.get(oldestScannedBlock);
    if (cached) {
      setOldestScannedDate(cached);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const block = await readProvider.getBlock(oldestScannedBlock);
        if (block && !cancelled) {
          const date = new Date(Number(block.timestamp) * 1000);
          blockTimestampCache.current.set(oldestScannedBlock, date);
          setOldestScannedDate(date);
        }
      } catch {
        // ignore — date estimation is best-effort
      }
    })();

    return () => { cancelled = true; };
  }, [oldestScannedBlock, readProvider]);

  /* ──────────── Bootstrap trigger (guarded by verbethClient) ──────────── */

  useEffect(() => {
    if (!readProvider || !address || !verbethClient || hasBootstrappedRef.current) return;
    hasBootstrappedRef.current = true;
    void performInitialScan();
  }, [address, performInitialScan, readProvider, verbethClient]);

  /* ───────────── Phase 2 — Real-time (block accumulation) ───────────── */

  useEffect(() => {
    if (!readProvider || !address) return;

    const drainAccumulated = async () => {
      const wsLatest = latestBlockRef.current;
      const lastKnown = lastKnownBlockRef.current;
      if (wsLatest === null || lastKnown === null) return;
      if (isScanningRef.current) return;

      // Clamp to what the public RPC actually knows
      const publicLatest = Number(await readProvider.getBlockNumber());
      const maxSafeBlock = Math.min(wsLatest, publicLatest) - REAL_TIME_BUFFER;
      if (maxSafeBlock <= lastKnown) {
        // No new blocks — try retrying failed ranges instead
        retryFailedRanges();
        return;
      }

      isScanningRef.current = true;
      try {
        await processRange(lastKnown + 1, maxSafeBlock);
        setLastKnownBlock(maxSafeBlock);
        lastKnownBlockRef.current = maxSafeBlock;
        await dbService.setLastKnownBlock(address, maxSafeBlock);
      } catch (error) {
        console.error("[verbeth] real-time scan error:", error);
      } finally {
        isScanningRef.current = false;
      }

      // After draining new blocks, try retrying failed ranges
      retryFailedRanges();
    };

    const retryFailedRanges = () => {
      const now = Date.now();
      const due = failedRangesRef.current.filter((r) => r.nextRetryAt <= now);
      if (due.length === 0) return;

      // Process retries (don't await — fire and forget within the interval)
      for (const range of due) {
        failedRangesRef.current = failedRangesRef.current.filter((r) => r !== range);

        processRange(range.fromBlock, range.toBlock).catch(() => {
          if (range.attempts >= MAX_FAILED_RETRIES) {
            droppedChunksRef.current++;
            console.warn(`[verbeth] permanently dropped range ${range.fromBlock}-${range.toBlock} after ${range.attempts} attempts`);
          } else {
            const nextDelay = RETRY_DELAYS[Math.min(range.attempts, RETRY_DELAYS.length - 1)];
            failedRangesRef.current.push({
              ...range,
              attempts: range.attempts + 1,
              nextRetryAt: Date.now() + nextDelay,
            });
          }
        });
      }
    };

    // WS subscription feeds latestBlockRef — 0 extra RPC calls
    let unwatchWs: (() => void) | undefined;
    if (viemClient) {
      unwatchWs = viemClient.watchBlockNumber({
        onBlockNumber: (blockNumber: bigint) => {
          latestBlockRef.current = Number(blockNumber);
        },
        onError: (err: unknown) => {
          console.warn("[verbeth] WS block subscription error:", err);
        },
        emitOnBegin: false,
        pollingInterval: ACCUMULATION_INTERVAL_MS,
      });
    }

    // Drain accumulated blocks every ACCUMULATION_INTERVAL_MS
    const drainInterval = setInterval(() => void drainAccumulated(), ACCUMULATION_INTERVAL_MS);

    // Fallback: if no viemClient (no WS), poll for block number
    let fallbackInterval: ReturnType<typeof setInterval> | undefined;
    if (!viemClient) {
      fallbackInterval = setInterval(async () => {
        try {
          const bn = Number(await readProvider.getBlockNumber());
          latestBlockRef.current = bn;
        } catch {
          // ignore
        }
      }, FALLBACK_POLL_INTERVAL_MS);
    }

    return () => {
      unwatchWs?.();
      clearInterval(drainInterval);
      if (fallbackInterval) clearInterval(fallbackInterval);
    };
  }, [address, processRange, readProvider, viemClient]);

  return {
    isInitialLoading,
    isLoadingMore,
    canLoadMore,
    syncProgress,
    loadMoreHistory,
    lastKnownBlock,
    oldestScannedBlock,
    oldestScannedDate,
    backfillCooldown,
  };
};
