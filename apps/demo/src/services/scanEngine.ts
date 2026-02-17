/**
 * Scan engine — pure functions extracted from useMessageListener.
*/

import { withRateLimit, notifyOutcome } from "./rpcLimiter.js";

/* ─── Constants (defined locally to avoid import.meta.env crash) ─── */

const MAX_RETRIES = 3;

/* ─── sleep ─── */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ─── Error classification ─── */

export type ErrorKind = "range" | "rate_limit" | "unknown";

export function classifyError(error: unknown): ErrorKind {
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  const code = (error as any)?.code;

  if (
    code === 429 ||
    msg.includes("too many requests") ||
    msg.includes("compute units per second capacity") ||
    msg.includes("concurrent requests capacity")
  ) return "rate_limit";

  if (
    msg.includes("block range") ||
    msg.includes("query returned more than") ||
    msg.includes("response size") ||
    msg.includes("result exceeds")
  ) return "range";

  return "unknown";
}

/* ─── Range planning ─── */

export function planRanges(
  fromBlock: number,
  toBlock: number,
  chunkSize: number,
): { fromBlock: number; toBlock: number }[] {
  if (fromBlock > toBlock || !Number.isFinite(fromBlock) || !Number.isFinite(toBlock)) return [];
  const size = Math.max(1, Math.floor(chunkSize));
  const ranges: { fromBlock: number; toBlock: number }[] = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + size - 1, toBlock);
    ranges.push({ fromBlock: start, toBlock: end });
    start = end + 1;
  }
  return ranges;
}

/* ─── ScanFailedError ─── */

export class ScanFailedError extends Error {
  fromBlock: number;
  toBlock: number;
  reason: ErrorKind;
  constructor(fromBlock: number, toBlock: number, reason: ErrorKind) {
    super(`Scan failed for ${fromBlock}-${toBlock} (${reason})`);
    this.name = "ScanFailedError";
    this.fromBlock = fromBlock;
    this.toBlock = toBlock;
    this.reason = reason;
  }
}

/* ─── safeGetLogs — fetch with bisection + retry ─── */

export async function safeGetLogs(
  provider: any,
  filter: Record<string, unknown>,
  fromBlock: number,
  toBlock: number,
  attempt = 0,
  _sleep: (ms: number) => Promise<void> = sleep,
): Promise<any[]> {
  if (fromBlock > toBlock || !Number.isFinite(fromBlock) || !Number.isFinite(toBlock)) return [];

  try {
    const result: any[] = await withRateLimit(() => provider.getLogs({ ...filter, fromBlock, toBlock }));
    notifyOutcome("ok");
    return result;
  } catch (error) {
    const kind = classifyError(error);
    if (kind !== "unknown") notifyOutcome(kind);

    if (kind === "range" && toBlock > fromBlock) {
      const mid = Math.floor((fromBlock + toBlock) / 2);
      const [left, right] = await Promise.all([
        safeGetLogs(provider, filter, fromBlock, mid, 0, _sleep),
        safeGetLogs(provider, filter, mid + 1, toBlock, 0, _sleep),
      ]);
      return [...left, ...right];
    }

    if (attempt < MAX_RETRIES) {
      const base = kind === "rate_limit" ? 1200 : 600;
      await _sleep(base * 2 ** attempt + Math.random() * 300);
      return safeGetLogs(provider, filter, fromBlock, toBlock, attempt + 1, _sleep);
    }

    throw new ScanFailedError(fromBlock, toBlock, kind);
  }
}
