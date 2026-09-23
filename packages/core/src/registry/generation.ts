/**
 * Registry generation counter (#3047).
 *
 * Per-class registry work — manifest discovery in
 * `ObjectRegistry.ensureManifestLoaded()`, the simple-name index behind
 * `findClass()` — is computed once and reused until the registry or the
 * manifest state it was derived from changes. This module is the single
 * invalidation signal: every writer of that state bumps the generation, and
 * every memo records the generation it was computed at.
 *
 * Writers that bump:
 * - the class registry and external-manifest cache maps (see
 *   {@link createGenerationTrackedMap}) on every `set`/`delete`/`clear`;
 * - in-place mutation of a registered class (`register()`,
 *   `registerFromManifest()`, tenant-scoped field injection, field-decorator
 *   capture, inheritance invalidation, `ObjectRegistry.clear()`);
 * - the static/test/local-test manifest setters.
 *
 * The counter lives on `globalThis`, like the rest of the registry state, so
 * every copy of smrt-core loaded into one process shares it. It has no
 * imports so any registry or manifest module can depend on it without a
 * cycle.
 */

declare global {
  // eslint-disable-next-line no-var
  var __smrtRegistryGeneration: number | undefined;
}

/** Brand shared by every smrt-core copy's tracked maps (symbol registry). */
const GENERATION_TRACKED = Symbol.for('smrt.registry.generationTrackedMap');

/** Current registry generation. Starts at 0. */
export function getRegistryGeneration(): number {
  return globalThis.__smrtRegistryGeneration ?? 0;
}

/**
 * Invalidate every generation-keyed registry memo. Call after any change to
 * registered classes, their field/method metadata, or loaded manifests.
 */
export function bumpRegistryGeneration(): void {
  globalThis.__smrtRegistryGeneration = getRegistryGeneration() + 1;
}

/**
 * True when `map` already bumps the registry generation on mutation — from
 * this or any other smrt-core copy (the brand is a registered symbol, so it
 * is identical across module instances where `instanceof` is not).
 */
export function isGenerationTrackedMap(map: unknown): boolean {
  return (
    map instanceof Map &&
    (map as unknown as Record<symbol, unknown>)[GENERATION_TRACKED] === true
  );
}

/**
 * A `Map` whose mutations bump the registry generation. Seeds from `entries`
 * (e.g. a plain map an older smrt-core copy created) without counting the
 * seed as a change beyond one bump.
 */
export function createGenerationTrackedMap<K, V>(
  entries?: Iterable<readonly [K, V]>,
): Map<K, V> {
  const map = new Map<K, V>(entries);
  const set = map.set.bind(map);
  const remove = map.delete.bind(map);
  const clear = map.clear.bind(map);
  Object.defineProperties(map, {
    [GENERATION_TRACKED]: { value: true },
    set: {
      value(key: K, value: V) {
        set(key, value);
        bumpRegistryGeneration();
        return map;
      },
    },
    delete: {
      value(key: K) {
        const deleted = remove(key);
        if (deleted) {
          bumpRegistryGeneration();
        }
        return deleted;
      },
    },
    clear: {
      value() {
        clear();
        bumpRegistryGeneration();
      },
    },
  });
  bumpRegistryGeneration();
  return map;
}
