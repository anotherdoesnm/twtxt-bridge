/**
 * Cheap protection for a small VPS: a per-IP request budget for the expensive
 * path (anything that triggers an outbound fetch) and a global cap on
 * concurrent outbound builds, so a scan can't open a thousand sockets.
 */

const WINDOW_MS = 60_000;
const PER_IP = Number(process.env.RATE_PER_MIN ?? 30);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 6);

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface Verdict {
  ok: boolean;
  retryAfter: number;
}

export function checkRate(ip: string): Verdict {
  const now = Date.now();
  const bucket = buckets.get(ip);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }

  if (bucket.count >= PER_IP) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  bucket.count += 1;
  return { ok: true, retryAfter: 0 };
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, WINDOW_MS);
sweeper.unref();

let active = 0;
const waiters: Array<() => void> = [];

export function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiters.push(resolve));
}

export function release(): void {
  const next = waiters.shift();
  if (next) next(); // hand the slot over, `active` stays the same
  else active -= 1;
}

export function clientIp(ctx: {
  req: { header(name: string): string | undefined };
  env: unknown;
}): string {
  const forwarded = ctx.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const env = ctx.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}
