import type { BlockRange } from "../../types.js";
import { splitRangeOnProviderLimit } from "./scanPlanner.js";

type RpcFilter = Record<string, unknown>;

export type FetcherTelemetryEvent =
  | { type: "rate_limit"; attempt: number }
  | { type: "retry"; attempt: number; error: string }
  | { type: "range_split"; from: number; to: number }
  | { type: "success"; from: number; to: number; logCount: number };

interface LogFetcherConfig {
  provider: any;
  maxRetries: number;
  maxRangeProvider: number;
  baseDelayMs?: number;
  onTelemetry?: (event: FetcherTelemetryEvent) => void;
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  return String(error ?? "").toLowerCase();
}

export function isRateLimitError(error: unknown): boolean {
  const message = toMessage(error);
  const code = (error as any)?.code;
  return (
    code === 429 ||
    message.includes("429") ||
    message.includes("rate") ||
    message.includes("too many request") ||
    message.includes("compute units exceeded") ||
    message.includes("limit")
  );
}

export function isRangeError(error: unknown): boolean {
  const message = toMessage(error);
  return (
    message.includes("block range") ||
    message.includes("query returned more than") ||
    message.includes("response size") ||
    message.includes("result exceeds")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(baseDelayMs: number, attempt: number): number {
  const jitter = Math.floor(Math.random() * 200);
  return Math.floor(baseDelayMs * 2 ** attempt) + jitter;
}

export function createLogFetcher(config: LogFetcherConfig) {
  const {
    provider,
    maxRetries,
    maxRangeProvider,
    baseDelayMs = 900,
    onTelemetry,
  } = config;

  async function getLogsForRange(
    filter: RpcFilter,
    range: BlockRange,
    attempt = 0
  ): Promise<any[]> {
    const splitRanges = splitRangeOnProviderLimit(
      range.fromBlock,
      range.toBlock,
      maxRangeProvider
    );

    if (splitRanges.length > 1) {
      const merged: any[] = [];
      for (const splitRange of splitRanges) {
        const logs = await getLogsForRange(filter, splitRange, 0);
        merged.push(...logs);
      }
      return merged;
    }

    try {
      const logs = await provider.getLogs({
        ...filter,
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
      });
      onTelemetry?.({ type: "success", from: range.fromBlock, to: range.toBlock, logCount: logs.length });
      return logs;
    } catch (error) {
      if (isRangeError(error) && range.fromBlock < range.toBlock) {
        const [left, right] = splitRangeOnProviderLimit(
          range.fromBlock,
          range.toBlock,
          Math.floor((range.toBlock - range.fromBlock) / 2)
        );
        if (left && right) {
          onTelemetry?.({ type: "range_split", from: range.fromBlock, to: range.toBlock });
          const leftLogs = await getLogsForRange(filter, left, 0);
          const rightLogs = await getLogsForRange(filter, right, 0);
          return [...leftLogs, ...rightLogs];
        }
      }

      if (isRateLimitError(error) && attempt < maxRetries) {
        onTelemetry?.({ type: "rate_limit", attempt });
        const wait = backoffMs(baseDelayMs, attempt);
        await sleep(wait);
        return getLogsForRange(filter, range, attempt + 1);
      }

      onTelemetry?.({ type: "retry", attempt, error: toMessage(error) });
      throw error;
    }
  }

  return {
    getLogsForRange,
  };
}
