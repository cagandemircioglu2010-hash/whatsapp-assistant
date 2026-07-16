import type { Pool } from "pg";

type Bucket = {
  tokens: number;
  updatedAt: number;
};

export interface RateLimitStore {
  consume(scope: string, subjectHash: string, capacity: number): Promise<boolean>;
}

export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly pool: Pool) {}

  async consume(scope: string, subjectHash: string, capacity: number): Promise<boolean> {
    if (!/^[a-z][a-z0-9_.-]{2,63}$/.test(scope)) throw new Error("Rate-limit scope is invalid");
    if (!/^[a-f0-9]{64}$/.test(subjectHash)) throw new Error("Rate-limit subject must be a keyed hash");
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000) {
      throw new Error("Rate-limit capacity is invalid");
    }
    const result = await this.pool.query<{ allowed: boolean }>(
      `INSERT INTO rate_limit_buckets (
         scope, subject_hash, window_started_at, request_count, expires_at
       ) VALUES ($1, $2, clock_timestamp(), 1, clock_timestamp() + INTERVAL '2 minutes')
       ON CONFLICT (scope, subject_hash) DO UPDATE SET
         request_count = CASE
           WHEN rate_limit_buckets.window_started_at <= clock_timestamp() - INTERVAL '1 minute' THEN 1
           ELSE rate_limit_buckets.request_count + 1
         END,
         window_started_at = CASE
           WHEN rate_limit_buckets.window_started_at <= clock_timestamp() - INTERVAL '1 minute'
             THEN clock_timestamp()
           ELSE rate_limit_buckets.window_started_at
         END,
         expires_at = clock_timestamp() + INTERVAL '2 minutes'
       RETURNING request_count <= $3::integer AS allowed`,
      [scope, subjectHash, capacity]
    );
    return result.rows[0]?.allowed === true;
  }
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly limiters = new Map<string, TokenBucketRateLimiter>();

  async consume(scope: string, subjectHash: string, capacity: number): Promise<boolean> {
    const limiterKey = `${scope}:${capacity}`;
    let limiter = this.limiters.get(limiterKey);
    if (!limiter) {
      limiter = new TokenBucketRateLimiter(capacity);
      this.limiters.set(limiterKey, limiter);
    }
    return limiter.consume(subjectHash);
  }
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly intervalMs = 60_000,
    private readonly maxTrackedKeys = 10_000
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Rate-limit capacity must be positive");
  }

  consume(key: string, now = Date.now()): boolean {
    const existing = this.buckets.get(key);
    const elapsed = Math.max(0, now - (existing?.updatedAt ?? now));
    const available = Math.min(
      this.capacity,
      (existing?.tokens ?? this.capacity) + (elapsed * this.capacity) / this.intervalMs
    );
    const allowed = available >= 1;
    this.buckets.delete(key);
    this.buckets.set(key, { tokens: allowed ? available - 1 : available, updatedAt: now });
    this.prune(now);
    return allowed;
  }

  private prune(now: number): void {
    if (this.buckets.size <= this.maxTrackedKeys) return;
    const expireBefore = now - this.intervalMs * 2;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAt < expireBefore || this.buckets.size > this.maxTrackedKeys) {
        this.buckets.delete(key);
      }
      if (this.buckets.size <= this.maxTrackedKeys) break;
    }
  }
}
