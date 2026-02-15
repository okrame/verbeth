import type { BlockRange } from "../../types.js";

export function normalizeBlockRange(
  fromBlock: number,
  toBlock: number
): BlockRange | null {
  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock)) return null;
  if (fromBlock > toBlock) return null;
  return { fromBlock, toBlock };
}

export function clampCursorToTip(cursor: number, tip: number): number {
  if (!Number.isFinite(cursor)) return tip;
  return Math.max(0, Math.min(cursor, tip));
}

export function planRanges(
  fromBlock: number,
  toBlock: number,
  chunkSize: number
): BlockRange[] {
  const normalized = normalizeBlockRange(fromBlock, toBlock);
  if (!normalized) return [];
  const size = Math.max(1, Math.floor(chunkSize));
  const ranges: BlockRange[] = [];
  let start = normalized.fromBlock;

  while (start <= normalized.toBlock) {
    const end = Math.min(start + size - 1, normalized.toBlock);
    ranges.push({ fromBlock: start, toBlock: end });
    start = end + 1;
  }

  return ranges;
}

export function splitRangeOnProviderLimit(
  fromBlock: number,
  toBlock: number,
  maxRangeProvider: number
): BlockRange[] {
  const normalized = normalizeBlockRange(fromBlock, toBlock);
  if (!normalized) return [];
  const limit = Math.max(1, Math.floor(maxRangeProvider));

  if (normalized.toBlock - normalized.fromBlock <= limit) {
    return [normalized];
  }

  const mid = normalized.fromBlock + Math.floor((normalized.toBlock - normalized.fromBlock) / 2);
  return [
    ...splitRangeOnProviderLimit(normalized.fromBlock, mid, limit),
    ...splitRangeOnProviderLimit(mid + 1, normalized.toBlock, limit),
  ];
}
