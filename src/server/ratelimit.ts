/**
 * In-memory rate limiter for the two unauthenticated routes.
 *
 * `/api/license/activate` and `/api/license/owner` are open by design — the lock
 * screen must be able to mint the first token — which also makes them the only
 * brute-force surface in the product. `HS_OWNER` only has to be 12 characters,
 * and the API answers any origin, so without a limiter a page could try
 * thousands of passcodes per minute.
 *
 * Policy per (scope, caller):
 *   - a sliding window of `max` attempts per `windowMs`;
 *   - after `failMax` consecutive failures a cooldown doubles from
 *     `cooldownMs`, capped at `maxCooldownMs`, and a success clears it.
 *
 * It is deliberately process-local: a hosted deployment runs one process, and a
 * restart clearing the counters is acceptable. State is swept so the map cannot
 * grow without bound in a long-lived process.
 */

interface Bucket {
  /** Timestamps of recent attempts inside the current window. */
  hits: number[];
  /** Consecutive failures, for the exponential cooldown. */
  fails: number;
  /** Epoch ms until which this caller is refused. */
  blockedUntil: number;
  lastSeen: number;
}

const buckets = new Map<string, Bucket>();
const SWEEP_EVERY_MS = 60_000;
let lastSweep = Date.now();

export interface LimitPolicy {
  windowMs: number;
  max: number;
  failMax: number;
  cooldownMs: number;
  maxCooldownMs: number;
}

export const POLICIES = {
  /** 10 password/key attempts a minute, then backoff after 5 straight misses. */
  license: {
    windowMs: 60_000,
    max: 10,
    failMax: 5,
    cooldownMs: 30_000,
    maxCooldownMs: 15 * 60_000,
  },
  /** Anything else that shells out or parses a container. */
  heavy: {
    windowMs: 60_000,
    max: 30,
    failMax: 0,
    cooldownMs: 0,
    maxCooldownMs: 0,
  },
} satisfies Record<string, LimitPolicy>;

function key(scope: string, caller: string): string {
  return `${scope}\u0000${caller}`;
}

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    const stale = now - b.lastSeen > 60 * 60_000;
    if (stale && b.blockedUntil < now) buckets.delete(k);
  }
}

function bucketOf(scope: string, caller: string, now: number): Bucket {
  const k = key(scope, caller);
  let b = buckets.get(k);
  if (!b) {
    b = { hits: [], fails: 0, blockedUntil: 0, lastSeen: now };
    buckets.set(k, b);
  }
  b.lastSeen = now;
  return b;
}

export interface LimitVerdict {
  ok: boolean;
  /** Milliseconds to wait before retrying (0 when allowed). */
  retryAfterMs: number;
}

/**
 * Count one attempt. Returns `ok: false` with a retry hint when the caller is
 * over the window or inside a cooldown. Allowed attempts are recorded, so
 * calling this twice for one request would double-count — call it once, at the
 * top of the route.
 */
export function take(
  scope: string,
  caller: string,
  policy: LimitPolicy = POLICIES.license,
  now = Date.now(),
): LimitVerdict {
  sweep(now);
  const b = bucketOf(scope, caller, now);
  if (b.blockedUntil > now) {
    return { ok: false, retryAfterMs: b.blockedUntil - now };
  }
  b.hits = b.hits.filter((t) => now - t < policy.windowMs);
  if (b.hits.length >= policy.max) {
    const oldest = b.hits[0] ?? now;
    return { ok: false, retryAfterMs: Math.max(1000, policy.windowMs - (now - oldest)) };
  }
  b.hits.push(now);
  return { ok: true, retryAfterMs: 0 };
}

/** Note a rejection (wrong key / expired / revoked). May open a cooldown. */
export function fail(
  scope: string,
  caller: string,
  policy: LimitPolicy = POLICIES.license,
  now = Date.now(),
): void {
  if (policy.failMax <= 0) return;
  const b = bucketOf(scope, caller, now);
  b.fails += 1;
  if (b.fails >= policy.failMax) {
    const over = b.fails - policy.failMax;
    const wait = Math.min(policy.maxCooldownMs, policy.cooldownMs * 2 ** Math.min(over, 6));
    b.blockedUntil = now + wait;
  }
}

/** A successful attempt clears THIS caller's failure streak (never anyone else's). */
export function succeed(scope: string, caller: string): void {
  const b = buckets.get(key(scope, caller));
  if (!b) return;
  b.fails = 0;
  b.blockedUntil = 0;
}

/** Test/diagnostic helper: forget every counter. */
export function reset(): void {
  buckets.clear();
}
