// apps/demo/src/hooks/useMessageListener.ts

import { useState, useEffect, useRef, useCallback } from "react";
import { keccak256, toUtf8Bytes } from "ethers";
import { dbService } from "../services/DbService.js";
import {
  LOGCHAIN_SINGLETON_ADDR,
  CONTRACT_CREATION_BLOCK,
  INITIAL_SCAN_BLOCKS,
  MAX_RETRIES,
  MAX_RANGE_PROVIDER,
  CHUNK_SIZE,
  REAL_TIME_BUFFER,
  EVENT_SIGNATURES,
  Contact,
  ScanProgress,
  ScanChunk,
  ProcessedEvent,
  MessageListenerResult,
} from "../types.js";

interface UseMessageListenerProps {
  readProvider: any;
  address: string | undefined;
  onLog: (message: string) => void;
  onEventsProcessed: (events: ProcessedEvent[]) => void;
}

export const useMessageListener = ({
  readProvider,
  address,
  onLog,
  onEventsProcessed,
}: UseMessageListenerProps): MessageListenerResult => {
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [canLoadMore, setCanLoadMore] = useState(true);
  const [syncProgress, setSyncProgress] = useState<ScanProgress | null>(null);
  const [lastKnownBlock, setLastKnownBlock] = useState<number | null>(null);
  const [oldestScannedBlock, setOldestScannedBlock] = useState<number | null>(
    null
  );

  const processedLogs = useRef(new Set<string>());
  const scanChunks = useRef<ScanChunk[]>([]);

  const calculateRecipientHash = (recipientAddr: string) => {
    return keccak256(toUtf8Bytes(`contact:${recipientAddr.toLowerCase()}`));
  };

  // Load contacts directly from database when needed
  const getCurrentContacts = useCallback(async (): Promise<Contact[]> => {
    if (!address) return [];
    try {
      return await dbService.getAllContacts(address);
    } catch (error) {
      onLog(`✗ Failed to load contacts: ${error}`);
      return [];
    }
  }, [address, onLog]);

  // RPC helper with retry logic
  const safeGetLogs = async (
    filter: any,
    fromBlock: number,
    toBlock: number,
    retries = MAX_RETRIES
  ): Promise<any[]> => {
    let attempt = 0;
    let delay = 1000;

    while (attempt < retries) {
      try {
        if (fromBlock > toBlock) {
          onLog(`⚠️ Invalid block range: ${fromBlock} > ${toBlock}`);
          return [];
        }

        if (toBlock - fromBlock > MAX_RANGE_PROVIDER) {
          const mid = fromBlock + Math.floor((toBlock - fromBlock) / 2);
          const firstHalf = await safeGetLogs(filter, fromBlock, mid, retries);
          const secondHalf = await safeGetLogs(
            filter,
            mid + 1,
            toBlock,
            retries
          );
          return [...firstHalf, ...secondHalf];
        }

        return await readProvider.getLogs({
          ...filter,
          fromBlock,
          toBlock,
        });
      } catch (error: any) {
        attempt++;

        if (
          error.code === 429 ||
          error.message?.includes("rate") ||
          error.message?.includes("limit") ||
          error.message?.includes("invalid block range")
        ) {
          if (attempt < retries) {
            onLog(
              `! RPC error, retrying in ${delay}ms... (attempt ${attempt}/${retries})`
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay *= 1.5;
            continue;
          }
        }

        if (
          error.message?.includes("exceed") ||
          error.message?.includes("range")
        ) {
          onLog(`✗ Block range error, skipping range ${fromBlock}-${toBlock}`);
          return [];
        }

        onLog(`✗ RPC error on range ${fromBlock}-${toBlock}: ${error.message}`);
        return [];
      }
    }

    onLog(
      `✗ Failed after ${retries} retries for range ${fromBlock}-${toBlock}`
    );
    return [];
  };

  // Smart chunking
  const findEventRanges = async (
    fromBlock: number,
    toBlock: number
  ): Promise<[number, number][]> => {
    const ranges: [number, number][] = [];
    let currentBlock = toBlock;

    while (currentBlock >= fromBlock) {
      const rangeStart = Math.max(currentBlock - CHUNK_SIZE, fromBlock);
      const rangeEnd = currentBlock;

      ranges.unshift([rangeStart, rangeEnd]);
      currentBlock = rangeStart - 1;

      if (ranges.length >= 5) break;
    }

    return ranges;
  };

  const batchScanRanges = async (
    ranges: [number, number][]
  ): Promise<ProcessedEvent[]> => {
    if (ranges.length > 1) {
      setSyncProgress({ current: 0, total: ranges.length });
    }

    let results: ProcessedEvent[] = [];
    let completedRanges = 0;

    for (const range of ranges) {
      const [start, end] = range;
      try {
        const chunkResults = await scanBlockRange(start, end);
        results = results.concat(chunkResults);
        completedRanges++;

        setSyncProgress({ current: completedRanges, total: ranges.length });

        if (completedRanges < ranges.length) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } catch (error) {
        onLog(`✗ Failed to scan range ${start}-${end}: ${error}`);
      }
    }

    setSyncProgress(null);
    return results;
  };

  // scan specific block range - load contacts from db when needed
  const scanBlockRange = async (
    fromBlock: number,
    toBlock: number
  ): Promise<ProcessedEvent[]> => {
    if (!address) return [];

    const contacts = await getCurrentContacts();

    const userRecipientHash = calculateRecipientHash(address);
    const allEvents: ProcessedEvent[] = [];

    try {
      const handshakeFilter = {
        address: LOGCHAIN_SINGLETON_ADDR,
        topics: [EVENT_SIGNATURES.Handshake, userRecipientHash],
      };
      const handshakeLogs = await safeGetLogs(
        handshakeFilter,
        fromBlock,
        toBlock
      );

      for (const log of handshakeLogs) {
        const logKey = `${log.transactionHash}-${log.logIndex}`;
        if (!processedLogs.current.has(logKey)) {
          processedLogs.current.add(logKey);
          allEvents.push({
            logKey,
            eventType: "handshake",
            rawLog: log,
            blockNumber: log.blockNumber,
            timestamp: Date.now(),
          });
        }
      }

      const pendingContacts = contacts.filter(
        (c) => c.status === "handshake_sent"
      );

      if (pendingContacts.length > 0) {
        const responseFilter = {
          address: LOGCHAIN_SINGLETON_ADDR,
          topics: [EVENT_SIGNATURES.HandshakeResponse],
        };
        const responseLogs = await safeGetLogs(
          responseFilter,
          fromBlock,
          toBlock
        );

        onLog(
          `🔍 Found ${responseLogs.length} total handshake responses in blocks ${fromBlock}-${toBlock}`
        );

        // Match by responder address
        for (const log of responseLogs) {
          const responderAddress = "0x" + log.topics[2].slice(-40);

          const matchingContact = pendingContacts.find(
            (c) => c.address.toLowerCase() === responderAddress.toLowerCase()
          );

          if (matchingContact) {
            const logKey = `${log.transactionHash}-${log.logIndex}`;
            if (!processedLogs.current.has(logKey)) {
              processedLogs.current.add(logKey);
              allEvents.push({
                logKey,
                eventType: "handshake_response",
                rawLog: log,
                blockNumber: log.blockNumber,
                timestamp: Date.now(),
              });
            }
          }
        }
      }

      const establishedContacts = contacts.filter(
        (c) => c.status === "established"
      );
      if (establishedContacts.length > 0) {
        // 1) INBOUND ONLY: listen exclusively to topics where we receive messages
        const inboundTopics = establishedContacts
          .map((c) => c.topicInbound)
          .filter(Boolean);

        if (inboundTopics.length > 0) {
          const messageFilterIn = {
            address: LOGCHAIN_SINGLETON_ADDR,
            topics: [EVENT_SIGNATURES.MessageSent, null, inboundTopics],
          };
          const inboundLogs = await safeGetLogs(
            messageFilterIn,
            fromBlock,
            toBlock
          );

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

        // 2) OUTBOUND CONFIRMATION: we do not need topic filter, we match logs where sender = our address
        if (address) {
          const senderTopic =
            "0x000000000000000000000000" + address.slice(2).toLowerCase();
          const messageFilterOutConfirm = {
            address: LOGCHAIN_SINGLETON_ADDR,
            topics: [EVENT_SIGNATURES.MessageSent, senderTopic],
          };
          const outLogs = await safeGetLogs(
            messageFilterOutConfirm,
            fromBlock,
            toBlock
          );

          for (const log of outLogs) {
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
    } catch (error) {
      onLog(`Error scanning block range ${fromBlock}-${toBlock}: ${error}`);
    }

    return allEvents;
  };

  const performInitialScan = useCallback(async () => {
    if (!readProvider || !address || isInitialLoading) return;

    // check if initial scan already completed for this address
    const initialScanComplete = await dbService.getInitialScanComplete(address);
    if (initialScanComplete) {
      onLog(`Initial scan already completed for ${address.slice(0, 8)}...`);

      const savedLastBlock = await dbService.getLastKnownBlock(address);
      const savedOldestBlock = await dbService.getOldestScannedBlock(address);

      if (savedLastBlock) setLastKnownBlock(savedLastBlock);
      if (savedOldestBlock) setOldestScannedBlock(savedOldestBlock);

      setCanLoadMore(
        savedOldestBlock ? savedOldestBlock > CONTRACT_CREATION_BLOCK : true
      );
      return;
    }

    setIsInitialLoading(true);
    onLog(`...Starting initial scan of last ${INITIAL_SCAN_BLOCKS} blocks...`);

    try {
      const currentBlock = await readProvider.getBlockNumber();
      const startBlock = Math.max(
        currentBlock - INITIAL_SCAN_BLOCKS,
        CONTRACT_CREATION_BLOCK
      );

      const events = await scanBlockRange(startBlock, currentBlock);

      onEventsProcessed(events);

      // store chunk info
      scanChunks.current = [
        {
          fromBlock: startBlock,
          toBlock: currentBlock,
          loaded: true,
          events: events.map((e) => e.rawLog),
        },
      ];

      // Update state and database
      setLastKnownBlock(currentBlock);
      setOldestScannedBlock(startBlock);
      setCanLoadMore(startBlock > CONTRACT_CREATION_BLOCK);

      await dbService.setLastKnownBlock(address, currentBlock);
      await dbService.setOldestScannedBlock(address, startBlock);
      await dbService.setInitialScanComplete(address, true);

      onLog(
        `Initial scan complete: ${events.length} events found in blocks ${startBlock}-${currentBlock}`
      );
    } catch (error) {
      onLog(`✗ Initial scan failed: ${error}`);
    } finally {
      setIsInitialLoading(false);
    }
  }, [
    readProvider,
    address,
    isInitialLoading,
    onLog,
    onEventsProcessed,
    getCurrentContacts,
  ]);

  const loadMoreHistory = useCallback(async () => {
    if (
      !readProvider ||
      !address ||
      isLoadingMore ||
      !canLoadMore ||
      !oldestScannedBlock
    ) {
      return;
    }

    setIsLoadingMore(true);
    onLog(`...Loading more history...`);

    try {
      const endBlock = oldestScannedBlock - 1;
      const startBlock = Math.max(
        endBlock - INITIAL_SCAN_BLOCKS,
        CONTRACT_CREATION_BLOCK
      );

      let maxIndexedBlock = endBlock;
      for (let b = endBlock; b >= startBlock; b--) {
        const blk = await readProvider.getBlock(b);
        if (blk) {
          maxIndexedBlock = b;
          break;
        }
      }

      if (maxIndexedBlock < startBlock) {
        onLog(
          `⚠️ No indexed blocks found between ${startBlock} and ${endBlock}. Retrying later.`
        );
        setIsLoadingMore(false);
        return;
      }

      const safeStartBlock = Math.max(startBlock, CONTRACT_CREATION_BLOCK);
      const safeEndBlock = maxIndexedBlock;

      const ranges = await findEventRanges(safeStartBlock, safeEndBlock);

      if (ranges.length === 0) {
        onLog(`No more events found before block ${safeEndBlock}`);
        setCanLoadMore(false);
        setIsLoadingMore(false);
        return;
      }

      const events = await batchScanRanges(ranges);

      onEventsProcessed(events);

      scanChunks.current.push({
        fromBlock: safeStartBlock,
        toBlock: safeEndBlock,
        loaded: true,
        events: events.map((e) => e.rawLog),
      });

      setOldestScannedBlock(safeStartBlock);
      setCanLoadMore(safeStartBlock > CONTRACT_CREATION_BLOCK);
      await dbService.setOldestScannedBlock(address, safeStartBlock);

      onLog(
        `Loaded ${events.length} more events from blocks ${safeStartBlock}-${safeEndBlock}`
      );
    } catch (error) {
      onLog(`✗ Failed to load more history: ${error}`);
    } finally {
      setIsLoadingMore(false);
    }
  }, [
    readProvider,
    address,
    isLoadingMore,
    canLoadMore,
    oldestScannedBlock,
    onLog,
    onEventsProcessed,
  ]);

  // real time scanning for new blocks
  useEffect(() => {
    if (!readProvider || !address || !lastKnownBlock) return;

    const interval = setInterval(async () => {
      try {
        const currentBlock = await readProvider.getBlockNumber();
        const maxSafeBlock = currentBlock - REAL_TIME_BUFFER;

        if (maxSafeBlock > lastKnownBlock) {
          const startScanBlock = lastKnownBlock + 1;
          const events = await scanBlockRange(startScanBlock, maxSafeBlock);

          if (events.length > 0) {
            onEventsProcessed(events);
            onLog(
              `Found ${events.length} new events in blocks ${startScanBlock}-${maxSafeBlock}`
            );
          }

          setLastKnownBlock(maxSafeBlock);
          await dbService.setLastKnownBlock(address, maxSafeBlock);
        }
      } catch (error) {
        onLog(`⚠️ Real-time scan error: ${error}`);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [readProvider, address, lastKnownBlock, onLog, onEventsProcessed]);

  // clear state when address changes
  useEffect(() => {
    if (address) {
      setIsInitialLoading(false);
      setIsLoadingMore(false);
      setCanLoadMore(true);
      setSyncProgress(null);
      setLastKnownBlock(null);
      setOldestScannedBlock(null);
      processedLogs.current.clear();
      scanChunks.current = [];
    }
  }, [address]);


  useEffect(() => {
    if (
      readProvider &&
      address &&
      !isInitialLoading &&
      scanChunks.current.length === 0
    ) {
      performInitialScan();
    }
  }, [readProvider, address, performInitialScan]);

  return {
    isInitialLoading,
    isLoadingMore,
    canLoadMore,
    syncProgress,
    loadMoreHistory,
    lastKnownBlock,
    oldestScannedBlock,
  };
};
