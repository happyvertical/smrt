/** Opt-in, live cookbook exposure. This leaf module is browser-safe. */
import type { CookbookEngine } from './cookbook/engine/engine.js';
import { modelParts, navItemId } from './cookbook/engine/nav.js';
import type { EngineCatalog, PlanSnapshot } from './cookbook/engine/types.js';

/** Data-only control identity; bootstraps recipes without model/schema readiness. */
export const COOKBOOK_TOOLS_MODEL = '@happyvertical/smrt-core:CookbookTools';

export interface RuntimeExposureContext {
  surface: 'rest' | 'mcp' | 'cli' | 'assistant' | 'screen';
  /** Resolved by the host, never from tool arguments. Missing context denies by default. */
  tenantId?: string | null;
  request?: Request;
  locals?: unknown;
}

export interface RuntimeExposureModel {
  qualifiedName?: string;
  /** Registry replacement provenance, not arbitrary inheritance. */
  replacedQualifiedNames?: readonly string[];
}

export interface RuntimeExposureGate {
  isEnabled(
    model: RuntimeExposureModel,
    context: RuntimeExposureContext,
  ): boolean;
  subscribe?(listener: () => void): () => void;
}

declare global {
  var __smrtRuntimeExposure:
    | {
        gate?: RuntimeExposureGate;
        unsubscribe?: () => void;
        listeners: Set<() => void>;
      }
    | undefined;
}

function state() {
  globalThis.__smrtRuntimeExposure ??= { listeners: new Set() };
  return globalThis.__smrtRuntimeExposure;
}

/** Whether this process opted into live exposure (also controls catalog cache policy). */
export function hasRuntimeExposureGate(): boolean {
  return !!state().gate;
}

/** Invalidate connected tool catalogs after cookbook or host-preference changes. */
export function notifyRuntimeExposureChanged(): void {
  for (const listener of [...state().listeners]) {
    try {
      listener();
    } catch {
      /* A disconnected client must not block a change. */
    }
  }
}

/** Install before serving requests. Undefined preserves the historical behavior. */
export function setRuntimeExposureGate(
  gate: RuntimeExposureGate | undefined,
): void {
  const slot = state();
  slot.unsubscribe?.();
  slot.gate = gate;
  slot.unsubscribe = gate?.subscribe?.(notifyRuntimeExposureChanged);
  notifyRuntimeExposureChanged();
}

/** Notification carries no tenant data; each client re-reads its own catalog. */
export function subscribeRuntimeExposure(listener: () => void): () => void {
  state().listeners.add(listener);
  return () => {
    state().listeners.delete(listener);
  };
}

/** Missing identity, unavailable enabled-set and predicate errors all fail closed. */
export function isRuntimeModelEnabled(
  model: RuntimeExposureModel | string | undefined,
  context: RuntimeExposureContext,
): boolean {
  const gate = state().gate;
  if (!gate) return true;
  try {
    return (
      gate.isEnabled(
        typeof model === 'string' ? { qualifiedName: model } : (model ?? {}),
        context,
      ) === true
    );
  } catch {
    return false;
  }
}

/** Filter AOT definitions for this request; never mutate or truncate the stored superset. */
export function filterRuntimeExposure<T>(
  definitions: readonly T[],
  model: (definition: T) => RuntimeExposureModel | string | undefined,
  context: RuntimeExposureContext,
): T[] {
  return definitions.filter((definition) =>
    isRuntimeModelEnabled(model(definition), context),
  );
}

export interface CookbookRuntimeExposureOptions {
  catalog: EngineCatalog;
  /** Must resolve the CURRENT, trusted tenant engine on every request. Null means unavailable. */
  engineFor(context: RuntimeExposureContext): CookbookEngine | null | undefined;
  /** ANDed with cookbook membership, evaluated on EVERY check. Exceptions deny. */
  predicate?(
    model: RuntimeExposureModel,
    context: RuntimeExposureContext,
  ): boolean;
  /** Optional AOT manifest provenance for app replacements, e.g. the generated consumer manifest. */
  replacements?: ReadonlyMap<string, string>;
  /** Default false: a missing tenant never selects an arbitrary engine. */
  allowWithoutTenant?: boolean;
}

/**
 * Reuse the command engine's live snapshots. Enabled sets are indexed once per
 * engine change; requests do a tenant lookup, Set membership and host predicate.
 * The host must return null while its cookbook store is unreadable, even when
 * an older engine exists. Persist/refresh engines in the host's storage adapter.
 */
export function createCookbookRuntimeExposure(
  options: CookbookRuntimeExposureOptions,
): RuntimeExposureGate & { dispose(): void } {
  const recipes = new Map(
    options.catalog.recipes.map((recipe) => [recipe.id, recipe]),
  );
  const known = new Set(
    options.catalog.models
      .filter((model) => model.exposed !== false)
      .map((model) => model.id),
  );
  const engines = new Map<
    CookbookEngine,
    { enabled: Set<string>; unsubscribe: () => void }
  >();
  const listeners = new Set<() => void>();
  let disposed = false;
  const effective = (id: string) => options.replacements?.get(id) ?? id;
  const enabledFrom = (snapshot: PlanSnapshot) => {
    const enabled = new Set(
      snapshot.features.filter((id) => known.has(id)).map(effective),
    );
    for (const entry of snapshot.recipes) {
      const recipe = recipes.get(entry.id);
      for (const id of recipe?.models ?? []) {
        if (known.has(id)) enabled.add(effective(id));
      }
    }
    return enabled;
  };
  return {
    isEnabled(model, context) {
      if (disposed || (!context.tenantId && !options.allowWithoutTenant))
        return false;
      const engine = options.engineFor(context);
      if (!engine) return false;
      let entry = engines.get(engine);
      if (!entry) {
        entry = { enabled: new Set(), unsubscribe: () => {} };
        const current = entry;
        // subscribe immediately delivers the current snapshot. Failure propagates
        // to the common fail-closed boundary; no stale default-open state.
        current.unsubscribe = engine.subscribe((snapshot) => {
          current.enabled = enabledFrom(snapshot);
          for (const listener of listeners) {
            try {
              listener();
            } catch {
              /* Isolate subscribers. */
            }
          }
        });
        engines.set(engine, current);
      }
      // Cookbook control tools bootstrap recipes; they use the host predicate
      // without depending on membership in an already enabled recipe.
      if (model.qualifiedName === COOKBOOK_TOOLS_MODEL) {
        return options.predicate
          ? options.predicate(model, context) === true
          : true;
      }
      const identities = [
        model.qualifiedName,
        ...(model.replacedQualifiedNames ?? []),
      ];
      return (
        identities.some((id) => !!id && entry.enabled.has(effective(id))) &&
        (options.predicate ? options.predicate(model, context) === true : true)
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      for (const entry of engines.values()) entry.unsubscribe();
      engines.clear();
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          /* Isolate disconnected subscribers. */
        }
      }
      listeners.clear();
    },
  };
}

/** Project screen/navigation data with the SAME gate as REST and tools. Hosts
 * subscribe and refresh this projection; direct screen URLs must also check
 * isRuntimeModelEnabled before rendering their AOT definition. */
export function filterRuntimeCookbookSnapshot(
  snapshot: PlanSnapshot,
  catalog: EngineCatalog,
  context: Omit<RuntimeExposureContext, 'surface'>,
): PlanSnapshot {
  const screen = { ...context, surface: 'screen' as const };
  const enabled = (model: string) => isRuntimeModelEnabled(model, screen);
  const items = new Set<string>();
  for (const recipe of catalog.recipes) {
    for (const entry of recipe.nav) {
      if (!enabled(entry.model)) continue;
      const parts = modelParts(catalog, entry.model);
      items.add(navItemId(parts.packageId, parts.name, entry.key));
    }
  }
  for (const model of catalog.models) {
    if (enabled(model.id)) items.add(navItemId(model.packageId, model.name));
  }
  return {
    ...snapshot,
    recipes: snapshot.recipes.filter((recipe) =>
      catalog.recipes
        .find((entry) => entry.id === recipe.id)
        ?.models.some(enabled),
    ),
    features: snapshot.features.filter(enabled),
    sections: snapshot.sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => items.has(item.id)),
      }))
      .filter((section) => section.items.length > 0),
  };
}
