import { dbService } from "../../services/DbService.js";
import type {
  ListenerSyncStatus,
  PendingRange,
  PersistedSyncState,
} from "../../types.js";

export function createDefaultSyncState(): PersistedSyncState {
  return {
    pendingRanges: [],
    status: "idle",
    updatedAt: Date.now(),
  };
}

export function toSyncStatus(state: PersistedSyncState): ListenerSyncStatus {
  const pending = state.pendingRanges.length;
  if (pending > 0 && state.status === "catching_up") {
    return {
      mode: "catching_up",
      pendingRanges: pending,
      lastError: state.lastError,
      isComplete: false,
    };
  }
  if (pending > 0 && state.status === "degraded") {
    return {
      mode: "retrying",
      pendingRanges: pending,
      lastError: state.lastError,
      isComplete: false,
    };
  }
  if (state.status === "degraded") {
    return {
      mode: "degraded",
      pendingRanges: pending,
      lastError: state.lastError,
      isComplete: false,
    };
  }
  if (state.status === "synced" && pending === 0) {
    return {
      mode: "synced",
      pendingRanges: 0,
      lastError: state.lastError,
      isComplete: true,
    };
  }
  return {
    mode: "idle",
    pendingRanges: pending,
    lastError: state.lastError,
    isComplete: pending === 0,
  };
}

export async function loadSyncState(addr: string): Promise<PersistedSyncState> {
  return (await dbService.getSyncState(addr)) ?? createDefaultSyncState();
}

export async function saveSyncState(
  addr: string,
  patch: Partial<PersistedSyncState>
): Promise<PersistedSyncState> {
  const prev = await loadSyncState(addr);
  const next: PersistedSyncState = {
    ...prev,
    ...patch,
    updatedAt: Date.now(),
  };
  await dbService.setSyncState(addr, next);
  return next;
}

export async function enqueueRanges(
  addr: string,
  ranges: PendingRange[],
  status: PersistedSyncState["status"],
  targetTip?: number
): Promise<PersistedSyncState> {
  const state = await loadSyncState(addr);
  const byRange = new Map<string, PendingRange>();

  for (const existing of state.pendingRanges) {
    byRange.set(`${existing.fromBlock}-${existing.toBlock}`, existing);
  }
  for (const incoming of ranges) {
    const key = `${incoming.fromBlock}-${incoming.toBlock}`;
    const prev = byRange.get(key);
    if (!prev) {
      byRange.set(key, incoming);
      continue;
    }
    byRange.set(key, {
      ...prev,
      ...incoming,
      attempts: Math.max(prev.attempts, incoming.attempts),
    });
  }

  const pendingRanges = Array.from(byRange.values()).sort((a, b) => {
    if (a.nextRetryAt !== b.nextRetryAt) return a.nextRetryAt - b.nextRetryAt;
    return a.fromBlock - b.fromBlock;
  });

  return saveSyncState(addr, {
    status,
    pendingRanges,
    targetTip: targetTip ?? state.targetTip,
  });
}

export async function dequeueRetryableRanges(
  addr: string,
  now: number,
  limit = 1
): Promise<PendingRange[]> {
  const prevState = await loadSyncState(addr);
  if (prevState.pendingRanges.length === 0) return [];

  const retryable = prevState.pendingRanges
    .filter((r) => r.nextRetryAt <= now)
    .sort((a, b) => {
      if (a.nextRetryAt !== b.nextRetryAt) return a.nextRetryAt - b.nextRetryAt;
      return a.attempts - b.attempts;
    })
    .slice(0, Math.max(1, limit));

  if (retryable.length === 0) return [];

  const retryableKeys = new Set(
    retryable.map((r) => `${r.fromBlock}-${r.toBlock}-${r.attempts}`)
  );
  const remaining = prevState.pendingRanges.filter(
    (r) => !retryableKeys.has(`${r.fromBlock}-${r.toBlock}-${r.attempts}`)
  );

  await saveSyncState(addr, {
    pendingRanges: remaining,
    status: remaining.length > 0 ? prevState.status : "synced",
    lastRetryAt: now,
  });

  return retryable;
}

export async function clearSyncState(addr: string): Promise<void> {
  await dbService.clearSyncState(addr);
}
