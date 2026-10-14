/**
 * Small in-process cache for expensive read-only aggregates (dashboard, reports). Concurrent
 * callers for the same key share one in-flight computation; failures are not cached.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    const value = load();
    this.entries.set(key, { at: now, value });
    value.catch(() => this.entries.delete(key));
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }

  clear() {
    this.entries.clear();
  }
}
