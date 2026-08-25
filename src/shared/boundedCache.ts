/** A fixed-capacity cache that evicts the least-recently-used entry. */
export class BoundedCache<K, V> {
  readonly #entries = new Map<K, V>();

  constructor(readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("BoundedCache maxEntries must be a positive integer");
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    if (!this.#entries.has(key)) {
      return undefined;
    }
    const value = this.#entries.get(key) as V;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.maxEntries) {
      const [oldest] = this.#entries.keys();
      this.#entries.delete(oldest as K);
    }
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}
