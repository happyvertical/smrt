/**
 * Lazy / execute-time agent_config resolvers.
 *
 * Persisted agent configs (e.g. `_smrt_agent_schedules.agent_config`) freeze
 * any value resolved at sync time, including env-derived ones. When operators
 * rotate an env var the persisted snapshot goes stale until the schedule is
 * rewritten.
 *
 * To avoid that, callers can store **sentinel references** in the persisted
 * config and register matching resolvers that run at execute time. The
 * runtime walks the agent_config tree, replaces every recognised sentinel
 * with the resolver's current return value, and only then hands the config
 * to the agent.
 *
 * Two registration shapes are supported:
 *
 * 1. **Global named resolvers** — register a callback by name once at
 *    application startup. Use this for shared resolvers like
 *    `resolveSharedAssetStorage`.
 *
 *    ```ts
 *    import { registerConfigResolver } from '@happyvertical/smrt-agents';
 *
 *    registerConfigResolver('sharedAssetStorage', () =>
 *      resolveSharedAssetStorage(),
 *    );
 *    ```
 *
 *    Then in the persisted agent_config:
 *    ```jsonc
 *    { "assetStorage": { "$env": "sharedAssetStorage" } }
 *    ```
 *
 * 2. **Per-agent class resolvers** — declare them as a static
 *    `configResolvers` map on the agent class. The runtime applies them on
 *    top of the persisted config keyed by the same name as the resolver.
 *
 *    ```ts
 *    class Praeco extends Agent {
 *      static configResolvers = {
 *        assetStorage: () => resolveSharedAssetStorage(),
 *      };
 *    }
 *    ```
 *
 * Both shapes can be combined freely. Global resolvers always take precedence
 * for `$env` sentinels; class resolvers fill in / override fields by name.
 *
 * @module
 */

/**
 * A lazy resolver — synchronous or async. Return values are merged into the
 * config tree at execute time. Throwing is allowed but is treated as a
 * resolution failure (see {@link ResolveLazyConfigOptions.onError}).
 */
export type ConfigResolver = () => unknown | Promise<unknown>;

/**
 * Sentinel object recognised inside agent_config to defer a value to a named
 * resolver. The runtime accepts both `$env` (preferred) and `$resolver` for
 * symmetry with similar systems.
 */
export interface LazyConfigSentinel {
  $env?: string;
  $resolver?: string;
}

/**
 * Options for resolving the lazy parts of a config tree.
 */
export interface ResolveLazyConfigOptions {
  /**
   * Per-class resolvers — typically the agent class's static
   * `configResolvers`. Applied as a key-by-key overlay on top of the
   * sentinel-resolved config.
   */
  classResolvers?: Record<string, ConfigResolver>;

  /**
   * Optional override for the global resolver registry. When omitted the
   * shared module-scoped registry is used. Useful for tests.
   */
  resolvers?: Map<string, ConfigResolver> | Record<string, ConfigResolver>;

  /**
   * What to do when a sentinel references a resolver that isn't registered,
   * or when a resolver throws.
   *
   * - `'leave'` (default): the sentinel is left in place verbatim. The
   *   downstream consumer is responsible for handling it.
   * - `'omit'`: the sentinel key is removed from the parent object/array.
   * - `'throw'`: re-throw the underlying error (or throw a new one for
   *   missing resolvers).
   */
  onError?: 'leave' | 'omit' | 'throw';
}

const globalResolvers = new Map<string, ConfigResolver>();

/**
 * Register a named resolver that participates in lazy config resolution.
 *
 * Calling this with the same name twice replaces the previous resolver — the
 * registry is intentionally last-write-wins so application boot ordering
 * doesn't have to be fragile.
 */
export function registerConfigResolver(
  name: string,
  resolver: ConfigResolver,
): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('registerConfigResolver: name must be a non-empty string');
  }
  if (typeof resolver !== 'function') {
    throw new Error('registerConfigResolver: resolver must be a function');
  }
  globalResolvers.set(name, resolver);
}

/**
 * Remove a previously registered resolver. Returns `true` if a resolver was
 * removed.
 */
export function unregisterConfigResolver(name: string): boolean {
  return globalResolvers.delete(name);
}

/**
 * Get the resolver registered under the given name, if any.
 */
export function getConfigResolver(name: string): ConfigResolver | undefined {
  return globalResolvers.get(name);
}

/**
 * List the names of all currently-registered global resolvers.
 */
export function listConfigResolvers(): string[] {
  return Array.from(globalResolvers.keys()).sort();
}

/**
 * Reset the global resolver registry. Primarily for tests.
 */
export function resetConfigResolvers(): void {
  globalResolvers.clear();
}

/**
 * Type guard that returns `true` if `value` is a lazy config sentinel.
 *
 * Recognises objects of the form `{ $env: string }` or
 * `{ $resolver: string }` exactly — extra keys disqualify the value so
 * arbitrary user data isn't accidentally treated as a sentinel.
 */
export function isLazyConfigSentinel(
  value: unknown,
): value is LazyConfigSentinel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1) return false;
  const key = keys[0];
  if (key !== '$env' && key !== '$resolver') return false;
  const resolverName = (value as Record<string, unknown>)[key];
  return typeof resolverName === 'string' && resolverName.length > 0;
}

/**
 * Extract the resolver name from a sentinel.
 */
function getSentinelName(sentinel: LazyConfigSentinel): string {
  return (sentinel.$env ?? sentinel.$resolver) as string;
}

function normalizeResolverMap(
  resolvers: Map<string, ConfigResolver> | Record<string, ConfigResolver>,
): Map<string, ConfigResolver> {
  if (resolvers instanceof Map) return resolvers;
  return new Map(Object.entries(resolvers));
}

const REMOVE = Symbol('LazyConfig.REMOVE');

async function resolveValue(
  value: unknown,
  resolvers: Map<string, ConfigResolver>,
  onError: NonNullable<ResolveLazyConfigOptions['onError']>,
  seen: WeakSet<object>,
): Promise<unknown> {
  if (isLazyConfigSentinel(value)) {
    const name = getSentinelName(value);
    const resolver = resolvers.get(name);
    if (!resolver) {
      if (onError === 'throw') {
        throw new Error(
          `Lazy config sentinel references unknown resolver "${name}"`,
        );
      }
      if (onError === 'omit') return REMOVE;
      return value;
    }

    try {
      return await resolver();
    } catch (error) {
      if (onError === 'throw') throw error;
      if (onError === 'omit') return REMOVE;
      return value;
    }
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    const next: unknown[] = [];
    for (const entry of value) {
      const resolved = await resolveValue(entry, resolvers, onError, seen);
      if (resolved !== REMOVE) next.push(resolved);
    }
    return next;
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) return value;
    seen.add(value);
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const resolved = await resolveValue(entry, resolvers, onError, seen);
      if (resolved !== REMOVE) next[key] = resolved;
    }
    return next;
  }

  return value;
}

/**
 * Resolve every lazy sentinel inside an `agent_config`-style record at
 * execute time. The input is not mutated; a new object is returned with
 * sentinel placeholders replaced by their resolver's current return value.
 *
 * Class-level resolvers from {@link ResolveLazyConfigOptions.classResolvers}
 * are applied as a final overlay so they always reflect the live value
 * regardless of what's persisted.
 *
 * @example Sentinel resolution
 * ```ts
 * registerConfigResolver('sharedAssetStorage', () => resolveStorage());
 *
 * const stored = { assetStorage: { $env: 'sharedAssetStorage' } };
 * const live = await resolveLazyConfig(stored);
 * // live.assetStorage === resolveStorage()
 * ```
 *
 * @example Class-level resolvers
 * ```ts
 * const live = await resolveLazyConfig(stored, {
 *   classResolvers: { assetStorage: () => resolveStorage() },
 * });
 * ```
 */
export async function resolveLazyConfig<T extends Record<string, unknown>>(
  config: T,
  options: ResolveLazyConfigOptions = {},
): Promise<T> {
  const onError = options.onError ?? 'leave';
  const resolvers = options.resolvers
    ? normalizeResolverMap(options.resolvers)
    : globalResolvers;

  const seen = new WeakSet<object>();
  const sentinelResolved = (await resolveValue(
    config,
    resolvers,
    onError,
    seen,
  )) as Record<string, unknown>;

  const result: Record<string, unknown> = { ...sentinelResolved };

  if (options.classResolvers) {
    for (const [key, resolver] of Object.entries(options.classResolvers)) {
      try {
        const value = await resolver();
        if (typeof value !== 'undefined') {
          result[key] = value;
        }
      } catch (error) {
        if (onError === 'throw') throw error;
        if (onError === 'omit') {
          delete result[key];
        }
        // 'leave': preserve the existing (possibly persisted) value.
      }
    }
  }

  return result as T;
}

/**
 * Look up the static `configResolvers` map on a class (or any of its
 * ancestors). Returns `undefined` if none is declared.
 *
 * The lookup walks the prototype chain so a subclass can extend its parent's
 * resolvers without redeclaring them.
 */
export function getClassConfigResolvers(
  ctor: unknown,
): Record<string, ConfigResolver> | undefined {
  if (typeof ctor !== 'function') return undefined;

  let current: any = ctor;
  let collected: Record<string, ConfigResolver> | undefined;

  while (current && current !== Function.prototype) {
    const resolvers = current.configResolvers;
    if (resolvers && typeof resolvers === 'object') {
      collected = {
        ...(resolvers as Record<string, ConfigResolver>),
        ...(collected ?? {}),
      };
    }
    current = Object.getPrototypeOf(current);
  }

  return collected;
}
