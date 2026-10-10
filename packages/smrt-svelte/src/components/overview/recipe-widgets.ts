/**
 * Recipe widgets (#3727, phase 2): turn the `widget` surfaces of manifest
 * recipes into widget-registry registrations.
 *
 * The manifest names a widget's component, server loader and migration as
 * `'<module specifier>#<ExportName>'` references and never imports them. This
 * helper receives the module resolver from the host, so nothing is imported at
 * scan time or when the manifest is read; the host decides how a specifier
 * becomes a module (a static map of dynamic imports in a bundled app).
 *
 * Svelte-free apart from type imports, so a server load can call it.
 */
import type {
  RecipeDefinition,
  RecipeExportRef,
  RecipeWidgetSurface,
} from '@happyvertical/smrt-types';
import type { Component } from 'svelte';
import type { WidgetRegistry } from './registry.js';
import type {
  OverviewOptions,
  WidgetComponentModule,
  WidgetComponentProps,
  WidgetDefinition,
  WidgetLoad,
  WidgetLoadContext,
  WidgetMigrate,
} from './types.js';

/**
 * Resolves one export of a module: `resolveExport('@acme/shop/svelte',
 * 'SalesTotal')`. The host owns this (import map, dynamic import, or a test
 * stub); it may reject or return `undefined` for something it does not know.
 */
export type RecipeExportResolver = (
  specifier: string,
  exportName: string,
) => unknown | Promise<unknown>;

/** The part of a recipe this helper reads; a manifest `RecipeDefinition` fits. */
export type RecipeWidgetSource = Pick<RecipeDefinition, 'id'> &
  Partial<Pick<RecipeDefinition, 'surfaces'>>;

export interface RegisterRecipeWidgetsOptions {
  /** Replace a type that is already registered instead of skipping it. */
  replace?: boolean;
  /**
   * Whether a recipe is on in this app. Widgets of a recipe that is off are
   * not registered, so they never appear in an add list. Default: all on.
   */
  enabled?: (recipeId: string) => boolean;
}

export type RecipeWidgetSkipReason =
  /** The type is already registered (a core widget or another recipe). */
  | 'duplicate_type'
  /** The surface does not form a valid widget definition. */
  | 'invalid'
  /** A module export the registration needs eagerly could not be resolved. */
  | 'unresolved';

/** A widget surface that was not registered, and why. */
export interface RecipeWidgetSkip {
  recipeId: string;
  type: string;
  reason: RecipeWidgetSkipReason;
  /** Developer-facing detail; not localized. */
  message: string;
}

export interface RecipeWidgetRegistration {
  /** Registered widget types, in registration order. */
  registered: string[];
  skipped: RecipeWidgetSkip[];
  /** Removes exactly the registrations this call made. */
  dispose: () => void;
}

/** Split `'<specifier>#<Name>'`; refuses relative and absolute specifiers. */
export function parseRecipeExportRef(
  ref: RecipeExportRef | string,
): { specifier: string; exportName: string } | null {
  const at = ref.lastIndexOf('#');
  if (at <= 0 || at === ref.length - 1) return null;
  const specifier = ref.slice(0, at);
  const exportName = ref.slice(at + 1);
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (/\s/.test(specifier) || !/^[A-Za-z_$][\w$]*$/.test(exportName)) {
    return null;
  }
  return { specifier, exportName };
}

function resolveRef(
  ref: RecipeExportRef,
  resolveExport: RecipeExportResolver,
): Promise<unknown> {
  const parsed = parseRecipeExportRef(ref);
  if (!parsed) return Promise.reject(new Error(`invalid export ref "${ref}"`));
  return Promise.resolve(
    resolveExport(parsed.specifier, parsed.exportName),
  ).then((value) => {
    if (value === undefined || value === null) {
      throw new Error(`export "${ref}" was not found`);
    }
    return value;
  });
}

/** Resolve once and share the result (and a failure) between callers. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= make();
    return pending;
  };
}

function isModuleWithDefault(
  value: unknown,
): value is { default: Component<WidgetComponentProps> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'default' in value &&
    !!(value as { default: unknown }).default
  );
}

function toDefinition(
  surface: RecipeWidgetSurface,
  resolveExport: RecipeExportResolver,
  migrate: WidgetMigrate | undefined,
): WidgetDefinition {
  const component = once(() => resolveRef(surface.export, resolveExport));
  const loadFn = surface.data?.load
    ? once(() =>
        resolveRef(surface.data?.load as RecipeExportRef, resolveExport),
      )
    : undefined;

  const def: WidgetDefinition = {
    type: surface.type,
    title: surface.label,
    options: surface.options ?? [],
    loadComponent: async () => {
      const value = await component();
      return (
        isModuleWithDefault(value) ? value.default : value
      ) as WidgetComponentModule<unknown>;
    },
  };
  if (surface.description !== undefined) def.description = surface.description;
  if (surface.icon !== undefined) def.icon = surface.icon;
  if (surface.version !== undefined) def.version = surface.version;
  if (surface.allowedIn) def.allowedIn = surface.allowedIn;
  if (surface.defaultSpan !== undefined) def.defaultSpan = surface.defaultSpan;
  if (surface.minSpan !== undefined) def.minSpan = surface.minSpan;
  if (surface.maxSpan !== undefined) def.maxSpan = surface.maxSpan;
  if (migrate) def.migrate = migrate;
  if (loadFn) {
    const load: WidgetLoad = async (
      options: OverviewOptions,
      ctx: WidgetLoadContext,
    ) => {
      const fn = await loadFn();
      if (typeof fn !== 'function') {
        throw new Error(`loader "${surface.data?.load}" is not a function`);
      }
      return (fn as WidgetLoad)(options, ctx);
    };
    def.load = load;
  }
  return def;
}

/**
 * Register every `widget` surface of `recipes` on `registry`.
 *
 * - Components resolve lazily (`loadComponent`); a page resolves them before
 *   render with `resolveWidgetComponents`, and one that cannot resolve renders
 *   as unavailable.
 * - The server loader resolves on the first `load`; a failure becomes that
 *   widget's error tile.
 * - `migrate` is synchronous in the registry, so its export is resolved here,
 *   before registering; if that fails the widget is skipped.
 * - Nothing here validates option values: `registry.register` validates the
 *   schema and spans, and a stored overview is validated against the result
 *   as for any widget.
 *
 * Never throws for a bad surface: it is reported in `skipped` so one broken
 * package cannot take down the overview.
 */
export async function registerRecipeWidgets(
  registry: WidgetRegistry,
  recipes: Iterable<RecipeWidgetSource>,
  resolveExport: RecipeExportResolver,
  options: RegisterRecipeWidgetsOptions = {},
): Promise<RecipeWidgetRegistration> {
  const registered: string[] = [];
  const skipped: RecipeWidgetSkip[] = [];
  const disposers: Array<() => void> = [];

  for (const recipe of recipes) {
    if (options.enabled && !options.enabled(recipe.id)) continue;
    for (const surface of recipe.surfaces ?? []) {
      if (surface.kind !== 'widget') continue;
      const skip = (reason: RecipeWidgetSkipReason, message: string) =>
        skipped.push({
          recipeId: recipe.id,
          type: surface.type,
          reason,
          message,
        });

      if (registry.has(surface.type) && !options.replace) {
        skip('duplicate_type', `"${surface.type}" is already registered`);
        continue;
      }

      let migrate: WidgetMigrate | undefined;
      if (surface.migrate) {
        try {
          const fn = await resolveRef(surface.migrate, resolveExport);
          if (typeof fn !== 'function') throw new Error('not a function');
          migrate = fn as WidgetMigrate;
        } catch (error) {
          skip(
            'unresolved',
            `migrate "${surface.migrate}": ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
      }

      try {
        disposers.push(
          registry.register(toDefinition(surface, resolveExport, migrate), {
            replace: options.replace,
          }),
        );
        registered.push(surface.type);
      } catch (error) {
        skip('invalid', error instanceof Error ? error.message : String(error));
      }
    }
  }

  return {
    registered,
    skipped,
    dispose: () => {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}
