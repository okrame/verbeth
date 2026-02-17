/**
 * Adaptive RPC rate limiter — self-tuning semaphore.
 *
 * Starts conservative (1 concurrent, 350ms spacing).
 * Ramps up after sustained success, backs off hard on 429.
 */

export const MIN_SPACING_MS = 150;
export const MAX_SPACING_MS = 2000;
export const MAX_CONCURRENT = 2;
export const RAMP_SPACING_STEP = 25;
export const SUCCESSES_TO_REDUCE_SPACING = 10;
export const SUCCESSES_TO_ADD_CONCURRENCY = 20;
export const BACKOFF_PAUSE_MS = 5000;

/* ── Mutable state ── */

let concurrent = 1; 
let spacingMs = 350; 
let backoffUntil = 0;
let successStreak = 0;

let active = 0;
let lastStartTime = 0;
const queue: Array<() => void> = [];

/* ── Internal ── */

function tryRelease() {
  if (queue.length > 0 && active < concurrent) {
    active++;
    const next = queue.shift()!;
    next();
  }
}

/* ── Public API ── */

/**
 * Called by safeGetLogs after each attempt to let the limiter adapt.
 */
export function notifyOutcome(kind: "ok" | "rate_limit" | "range"): void {
  if (kind === "ok") {
    successStreak++;
    if (successStreak >= SUCCESSES_TO_ADD_CONCURRENCY) {
      concurrent = Math.min(MAX_CONCURRENT, concurrent + 1);
    }
    if (successStreak >= SUCCESSES_TO_REDUCE_SPACING) {
      spacingMs = Math.max(MIN_SPACING_MS, spacingMs - RAMP_SPACING_STEP);
    }
    return;
  }

  if (kind === "rate_limit") {
    concurrent = 1;
    spacingMs = Math.min(MAX_SPACING_MS, spacingMs * 2);
    backoffUntil = Date.now() + BACKOFF_PAUSE_MS;
    successStreak = 0;
    return;
  }

  // "range" — not a rate issue, don't touch limiter state
}

export async function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  // Respect backoff pause
  const now = Date.now();
  if (now < backoffUntil) {
    await new Promise((resolve) => setTimeout(resolve, backoffUntil - now));
  }

  // Wait for a concurrency slot
  if (active >= concurrent) {
    await new Promise<void>((resolve) => queue.push(resolve));
  } else {
    active++;
  }

  // Enforce min spacing between request starts
  const elapsed = Date.now() - lastStartTime;
  if (elapsed < spacingMs) {
    await new Promise((resolve) => setTimeout(resolve, spacingMs - elapsed));
  }
  lastStartTime = Date.now();

  try {
    // DEV: simulate 429s — toggle from console: window.__sim429 = 0.4
    const sim429 = (globalThis as any).__sim429 as number | undefined;
    if (sim429 && Math.random() < sim429) {
      const err = new Error("Too Many Requests");
      (err as any).code = 429;
      throw err;
    }
    return await fn();
  } finally {
    active--;
    tryRelease();
  }
}

/* ── Test helpers ── */

export function resetLimiter(): void {
  concurrent = 1;
  spacingMs = 350;
  backoffUntil = 0;
  successStreak = 0;
  active = 0;
  queue.length = 0;
  lastStartTime = 0;
}

export function getLimiterState() {
  return { concurrent, spacingMs, backoffUntil, successStreak, active, queueLength: queue.length };
}

/* ── DEV: expose limiter state to console ── */
(globalThis as any).__rpcLimiter = {
  get concurrent() { return concurrent; },
  get spacingMs() { return spacingMs; },
  get backoffUntil() { return backoffUntil; },
  get successStreak() { return successStreak; },
  get active() { return active; },
  get queueLength() { return queue.length; },
};
