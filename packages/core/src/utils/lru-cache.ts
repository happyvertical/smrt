/**
 * Simple LRU (Least Recently Used) Cache implementation
 *
 * Automatically evicts least recently used entries when size limit is reached.
 * Useful for preventing memory leaks in long-running applications.
 */
export class LRUCache<K, V> {
  private cache: Map<K, V>;
  private readonly maxSize: number;

  /**
   * Create an LRU cache with a maximum size
   *
   * @param maxSize - Maximum number of entries to store (default: 100)
   */
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  /**
   * Get a value from the cache
   * Marks the entry as recently used (moves to end of Map)
   *
   * @param key - Cache key
   * @returns Value if found, undefined otherwise
   */
  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }

    // Move to end (most recently used)
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);

    return value;
  }

  /**
   * Set a value in the cache
   * Evicts least recently used entry if cache is full
   *
   * @param key - Cache key
   * @param value - Value to store
   */
  set(key: K, value: V): void {
    // Remove if exists (will re-add at end)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict least recently used entry if at capacity
    if (this.cache.size >= this.maxSize) {
      // First entry is least recently used (Map maintains insertion order)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    // Add as most recently used (at end)
    this.cache.set(key, value);
  }

  /**
   * Check if key exists in cache
   *
   * @param key - Cache key
   * @returns True if key exists
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Remove an entry from the cache
   *
   * @param key - Cache key
   * @returns True if entry was removed, false if not found
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries from the cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size
   *
   * @returns Number of entries in cache
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get all keys in the cache (least to most recently used)
   *
   * @returns Array of keys
   */
  keys(): K[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Get all values in the cache (least to most recently used)
   *
   * @returns Array of values
   */
  values(): V[] {
    return Array.from(this.cache.values());
  }
}
