type Bucket = {
  tokens: number;
  updatedAt: number;
};

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
