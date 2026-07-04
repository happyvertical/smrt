/**
 * @happyvertical/smrt-web — shared durable-store foundation (#1755).
 *
 * The ONE SMRT-layer namespacing + wipe registry that the future offline
 * outbox (#1762) and persistence (#1764) slices both build on. Pure bookkeeping
 * — ZERO client-data-engine (`@tanstack/*`) imports — so it stays inside the
 * engine-absorption boundary and ships now, before either consumer exists, so
 * the two slices agree on it from day one.
 *
 * Why a SMRT-layer registry rather than one storage engine: TanStack DB
 * persistence (SQLite-WASM / OPFS) and `@tanstack/offline-transactions`
 * (IndexedDB) are SEPARATE storage engines. There is no single primitive that
 * spans both, so the shared foundation lives one level up — a deterministic
 * namespace both slices key their own storage under, plus a registry so
 * {@link wipeDurableStore} can clear BOTH through one call without the outbox
 * and persistence modules importing each other. A logout / tenant-switch wipes
 * every durable artifact for a namespace in one place.
 *
 * Nothing in this package calls these yet — the seam ships ahead of its
 * consumers by design (see PRD #1755).
 */

/**
 * The identity a durable namespace is derived from. Combining the API base with
 * the tenant + identity + manifest hash means a logout, a tenant switch, or a
 * schema change each land on a DIFFERENT namespace, so durable artifacts are
 * never reused across those boundaries.
 *
 * `manifestHash` is supplied by the caller (its source is #1764's call — a
 * schema-shape digest); this module is source-agnostic and treats it as an
 * opaque discriminator.
 */
export interface DurableStoreKey {
  /** API base path the durable data was fetched against (e.g. `/api/v1`). */
  apiBase: string;
  /** Active tenant id, if any — absent means the single-tenant / global scope. */
  tenantId?: string;
  /** Authenticated identity id, if any — absent means anonymous. */
  identityId?: string;
  /** Opaque schema-shape digest; a change forces a fresh namespace. */
  manifestHash: string;
}

/**
 * Compute the deterministic storage namespace for a {@link DurableStoreKey}.
 * The same key always yields the same string; **any differing segment yields a
 * different one** (injective) — this is critical because the namespace IS the
 * tenant/identity/api isolation + wipe boundary, so a collision would reuse or
 * wipe durable data ACROSS those boundaries.
 *
 * Injectivity is guaranteed two ways: every segment is `encodeURIComponent`-
 * encoded, so a raw `:` in a value becomes `%3A` and can never be mistaken for a
 * separator; and an ABSENT `tenantId` / `identityId` maps to the empty string
 * while a PRESENT value is encoded, so a real id of `-` no longer collides with
 * "no tenant". Both future slices key their own storage primitive (IndexedDB
 * store name, OPFS path, …) under this string.
 */
export function durableStoreNamespace(key: DurableStoreKey): string {
  const seg = (value: string | undefined): string =>
    value === undefined ? '' : encodeURIComponent(value);
  return `smrt-web:${encodeURIComponent(key.apiBase)}:${seg(key.tenantId)}:${seg(key.identityId)}:${encodeURIComponent(key.manifestHash)}`;
}

/**
 * A durable artifact registered under a namespace — the outbox queue (#1762) or
 * a persisted collection store (#1764). Each owns its storage engine and
 * exposes only a `clear()` so {@link wipeDurableStore} can tear it down without
 * knowing which engine backs it.
 */
export interface DurableResource {
  /** Which slice owns this artifact — for diagnostics and selective sweeps. */
  readonly kind: 'outbox' | 'persisted-collection';
  /** Drop this artifact's durable storage. Best-effort; may reject. */
  clear(): Promise<void>;
}

/**
 * Registry of durable artifacts keyed by namespace. A `Set` per namespace so a
 * resource registers and unregisters without positional bookkeeping, and so two
 * slices (outbox + persistence) coexist under one namespace.
 */
const registry = new Map<string, Set<DurableResource>>();

/**
 * Register a durable artifact under a namespace so {@link wipeDurableStore} can
 * later clear it. Returns an unregister function that removes just this
 * resource — call it when the artifact is disposed on its own (before any
 * namespace-wide wipe) so it is not cleared twice.
 */
export function registerDurableResource(
  namespace: string,
  resource: DurableResource,
): () => void {
  let resources = registry.get(namespace);
  if (!resources) {
    resources = new Set<DurableResource>();
    registry.set(namespace, resources);
  }
  resources.add(resource);

  return () => {
    const current = registry.get(namespace);
    if (!current) return;
    current.delete(resource);
    if (current.size === 0) registry.delete(namespace);
  };
}

/**
 * Clear every durable artifact registered under `namespace`, then drop the
 * namespace. This is the single teardown point a logout / tenant-switch calls:
 * it fans out across BOTH the outbox and persistence slices via the registry,
 * so neither module needs to import the other.
 *
 * Best-effort: a resource whose `clear()` rejects does not abort the sweep —
 * every registered resource is still cleared (a wipe is a teardown, not a
 * transaction). A safe no-op on an unknown or empty namespace.
 */
export async function wipeDurableStore(namespace: string): Promise<void> {
  const resources = registry.get(namespace);
  if (!resources || resources.size === 0) {
    registry.delete(namespace);
    return;
  }
  // Snapshot so a resource that unregisters itself inside clear() cannot mutate
  // the set mid-iteration. allSettled keeps a rejected clear() from aborting the
  // others.
  const snapshot = [...resources];
  registry.delete(namespace);
  await Promise.allSettled(snapshot.map((resource) => resource.clear()));
}
