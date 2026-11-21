/**
 * The binding's usage tags on every call of a tier client (#5489).
 *
 * A client `getAiClient(tier)` returns (a single target or an executor's
 * chain, and so every tracked client and workflow step built on it) stamps
 * its binding's `source` and own `usageTags` on each `message`, `chat`,
 * `complete` and `stream` call. They are merged over the call's own
 * `usageTags`, so a caller's tag never changes where a call is billed:
 * hosted spend is metered from `source: hosted`, and a call that ran on a
 * hosted binding always carries it.
 *
 * @internal Not part of the package surface.
 */

const TAGGED_METHODS = new Set(['message', 'chat', 'complete', 'stream']);

const wrapped = new WeakMap<object, Map<string, object>>();

/**
 * The call's options with `tags` over its own `usageTags`. Each own
 * enumerable key is copied once and `runContext` is read once by ordinary
 * property access, so a run context reached through the options' prototype
 * is kept (as run tracking reads it).
 */
function taggedOptions(
  raw: unknown,
  tags: Record<string, string>,
): Record<PropertyKey, unknown> {
  const copy: Record<PropertyKey, unknown> = {};
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const source = raw as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(source)) {
      if (key === 'runContext') continue;
      if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue;
      copy[key] = source[key];
    }
    const runContext = source.runContext;
    if (runContext !== undefined) copy.runContext = runContext;
  }
  const own = copy.usageTags;
  copy.usageTags = {
    ...(own !== null && typeof own === 'object'
      ? (own as Record<string, string>)
      : {}),
    ...tags,
  };
  return copy;
}

/**
 * `client` with `tags` stamped over every model call's `usageTags`. Cached
 * per client and tag set, so identity is stable for one binding.
 */
export function withInferenceBindingTags<T>(
  client: T,
  tags: Record<string, string>,
): T {
  if (!client || typeof client !== 'object') return client;
  const stamp = { ...tags };
  // Nothing to stamp: the client itself, so its identity is unchanged.
  if (Object.keys(stamp).length === 0) return client;
  const key = JSON.stringify(Object.entries(stamp).sort());
  let byTags = wrapped.get(client as object);
  const cached = byTags?.get(key);
  if (cached) return cached as T;
  const proxy = new Proxy(client as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') {
        return value;
      }
      if (!TAGGED_METHODS.has(property)) return value.bind(target);
      // Synchronous: `stream()` returns its iterable as the client does.
      return (input: unknown, raw?: unknown, ...rest: unknown[]) =>
        value.call(target, input, taggedOptions(raw, stamp), ...rest);
    },
  });
  if (!byTags) {
    byTags = new Map();
    wrapped.set(client as object, byTags);
  }
  byTags.set(key, proxy);
  return proxy as T;
}
