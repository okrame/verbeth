import type { ListenerHealthLevel, ListenerHealthReason, ListenerHealthStatus, ListenerSyncMode } from "../../types.js";

export interface HealthMetrics {
  rateLimitEvents: number[];
  wsErrors: number[];
  pendingRanges: number;
  pendingRangesSince: number | null;
  tipLagBlocks: number;
  tipLagSince: number | null;
  syncMode: ListenerSyncMode;
}

const WINDOW_MS = 60_000;
const RATE_LIMIT_THRESHOLD = 5;
const WS_ERROR_THRESHOLD = 3;
const BACKLOG_THRESHOLD = 10;
const BACKLOG_SUSTAINED_MS = 30_000;
const TIP_LAG_THRESHOLD = 20;
const TIP_LAG_SUSTAINED_MS = 30_000;

export function pruneWindow(events: number[], windowMs: number): number[] {
  const cutoff = Date.now() - windowMs;
  return events.filter((t) => t > cutoff);
}

export function evaluateHealth(metrics: HealthMetrics): ListenerHealthStatus {
  const now = Date.now();
  const reasons: ListenerHealthReason[] = [];

  if (metrics.syncMode === "degraded") {
    reasons.push("backlog");
  }

  const recentRateLimits = metrics.rateLimitEvents.filter((t) => t > now - WINDOW_MS);
  if (recentRateLimits.length >= RATE_LIMIT_THRESHOLD) {
    reasons.push("rate_limit");
  }

  const recentWsErrors = metrics.wsErrors.filter((t) => t > now - WINDOW_MS);
  if (recentWsErrors.length >= WS_ERROR_THRESHOLD) {
    reasons.push("ws_error");
  }

  if (
    metrics.pendingRanges >= BACKLOG_THRESHOLD &&
    metrics.pendingRangesSince !== null &&
    now - metrics.pendingRangesSince >= BACKLOG_SUSTAINED_MS
  ) {
    if (!reasons.includes("backlog")) {
      reasons.push("backlog");
    }
  }

  if (
    metrics.tipLagBlocks >= TIP_LAG_THRESHOLD &&
    metrics.tipLagSince !== null &&
    now - metrics.tipLagSince >= TIP_LAG_SUSTAINED_MS
  ) {
    reasons.push("tip_lag");
  }

  const level: ListenerHealthLevel = reasons.length > 0 ? "warning" : "ok";
  return {
    level,
    reasons,
    message: level === "ok" ? "" : formatHealthMessage(reasons),
    updatedAt: now,
  };
}

export function formatHealthMessage(reasons: ListenerHealthReason[]): string {
  const parts: string[] = [];
  for (const r of reasons) {
    switch (r) {
      case "rate_limit":
        parts.push("RPC rate limits detected");
        break;
      case "backlog":
        parts.push("block scan backlog building up");
        break;
      case "tip_lag":
        parts.push("read node falling behind chain tip");
        break;
      case "ws_error":
        parts.push("WebSocket connection errors");
        break;
    }
  }
  return parts.join("; ") + ". Messaging remains fully functional.";
}

export const OK_HEALTH: ListenerHealthStatus = {
  level: "ok",
  reasons: [],
  message: "",
  updatedAt: 0,
};
