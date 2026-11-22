/**
 * Read-only views of a set and a map (#5195).
 *
 * A request's permissions and its resolved tenancy are read by every check
 * the request reaches, so nothing the request runs may change them after
 * resolution. A `Set` or `Map` subclass whose mutators throw is not enough:
 * the instance still carries the built-in internal slot, so
 * `Set.prototype.add.call(view, slug)` succeeds. These views hold their
 * entries in a private field and carry no built-in slot, so every built-in
 * mutator called on them throws, and their own mutators throw too.
 *
 * Reading is unchanged: `has`, `size`, iteration, `forEach` (which passes the
 * view itself as the collection argument), `keys`, `values`, `entries`, and
 * the set-algebra methods, which return new plain sets. A view is not a
 * `Set` instance (`instanceof Set` is false) and is frozen.
 */

const READ_ONLY = 'This collection is read-only';

function refuse(): never {
  throw new TypeError(READ_ONLY);
}

/** The read surface a set-algebra method needs from its argument. */
interface ReadonlySetLike<T> {
  readonly size: number;
  has(value: T): boolean;
  keys(): Iterator<T>;
}

/** A frozen, read-only view of a set's entries at construction. */
export class ReadonlySetView<T> implements ReadonlySet<T> {
  readonly #entries: Set<T>;

  constructor(values: Iterable<T> = []) {
    this.#entries = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.size;
  }

  has(value: T): boolean {
    return this.#entries.has(value);
  }

  forEach(
    callback: (value: T, key: T, set: ReadonlySet<T>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.#entries) {
      callback.call(thisArg, value, value, this);
    }
  }

  keys(): SetIterator<T> {
    return this.#entries.keys();
  }

  values(): SetIterator<T> {
    return this.#entries.values();
  }

  entries(): SetIterator<[T, T]> {
    return this.#entries.entries();
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.#entries.values();
  }

  get [Symbol.toStringTag](): string {
    return 'ReadonlySetView';
  }

  union<U>(other: ReadonlySetLike<U>): Set<T | U> {
    const out = new Set<T | U>(this.#entries);
    const iterator = other.keys();
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      out.add(next.value);
    }
    return out;
  }

  intersection<U>(other: ReadonlySetLike<U>): Set<T & U> {
    const out = new Set<T & U>();
    for (const value of this.#entries) {
      if ((other as unknown as ReadonlySetLike<T>).has(value)) {
        out.add(value as T & U);
      }
    }
    return out;
  }

  difference<U>(other: ReadonlySetLike<U>): Set<T> {
    const out = new Set<T>();
    for (const value of this.#entries) {
      if (!(other as unknown as ReadonlySetLike<T>).has(value)) out.add(value);
    }
    return out;
  }

  symmetricDifference<U>(other: ReadonlySetLike<U>): Set<T | U> {
    const out = new Set<T | U>(this.difference(other));
    const iterator = other.keys();
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      if (!this.#entries.has(next.value as unknown as T)) out.add(next.value);
    }
    return out;
  }

  isSubsetOf(other: ReadonlySetLike<unknown>): boolean {
    for (const value of this.#entries) {
      if (!other.has(value)) return false;
    }
    return true;
  }

  isSupersetOf(other: ReadonlySetLike<unknown>): boolean {
    const iterator = other.keys();
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      if (!this.#entries.has(next.value as T)) return false;
    }
    return true;
  }

  isDisjointFrom(other: ReadonlySetLike<unknown>): boolean {
    for (const value of this.#entries) {
      if (other.has(value)) return false;
    }
    return true;
  }

  /** Refused: the view is read-only. */
  add(_value: T): never {
    return refuse();
  }

  /** Refused: the view is read-only. */
  delete(_value: T): never {
    return refuse();
  }

  /** Refused: the view is read-only. */
  clear(): never {
    return refuse();
  }
}

/** A frozen, read-only view of a map's entries at construction. */
export class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
  readonly #entries: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]> = []) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    return this.#entries.get(key);
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  forEach(
    callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#entries) {
      callback.call(thisArg, value, key, this);
    }
  }

  keys(): MapIterator<K> {
    return this.#entries.keys();
  }

  values(): MapIterator<V> {
    return this.#entries.values();
  }

  entries(): MapIterator<[K, V]> {
    return this.#entries.entries();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#entries.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'ReadonlyMapView';
  }

  /** Refused: the view is read-only. */
  set(_key: K, _value: V): never {
    return refuse();
  }

  /** Refused: the view is read-only. */
  delete(_key: K): never {
    return refuse();
  }

  /** Refused: the view is read-only. */
  clear(): never {
    return refuse();
  }
}

// The prototypes are frozen too, so no request code can swap a reader.
Object.freeze(ReadonlySetView.prototype);
Object.freeze(ReadonlyMapView.prototype);

/**
 * A read-only view of `values`: a copy taken now. Passing a view returns it
 * unchanged.
 */
export function readonlySetOf<T>(values: Iterable<T>): ReadonlySetView<T> {
  return values instanceof ReadonlySetView
    ? values
    : new ReadonlySetView(values);
}

/** Whether `value` is a read-only set view from this module. */
export function isReadonlySetView(
  value: unknown,
): value is ReadonlySetView<unknown> {
  return value instanceof ReadonlySetView;
}
