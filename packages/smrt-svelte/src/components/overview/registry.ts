/**
 * The widget registry (#3727): `registerWidget({ type, component, options,
 * load, allowedIn, version, migrate })`. Registration is code, done once at
 * module scope by the app or a package; what a user stores is only data that
 * names a registered type, validated against it on save and on load.
 *
 * Svelte-free apart from type imports, so a server load can use it.
 */
import type { Component } from 'svelte';
import { assertWidgetOptionFields } from './schema.js';
import {
  OVERVIEW_MAX_SPAN,
  OVERVIEW_MIN_SPAN,
  OVERVIEW_PAGE_ID_PATTERN,
  type RegisteredWidget,
  WIDGET_TYPE_PATTERN,
  type WidgetComponentModule,
  type WidgetComponentProps,
  type WidgetDefinition,
} from './types.js';

function toRegistered(def: WidgetDefinition): RegisteredWidget {
  if (!WIDGET_TYPE_PATTERN.test(def.type)) {
    throw new Error(`registerWidget: invalid widget type "${def.type}"`);
  }
  const version = def.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`widget "${def.type}": version must be a positive integer`);
  }
  const minSpan = def.minSpan ?? OVERVIEW_MIN_SPAN;
  const maxSpan = def.maxSpan ?? OVERVIEW_MAX_SPAN;
  if (
    !Number.isInteger(minSpan) ||
    !Number.isInteger(maxSpan) ||
    minSpan < OVERVIEW_MIN_SPAN ||
    maxSpan > OVERVIEW_MAX_SPAN ||
    minSpan > maxSpan
  ) {
    throw new Error(`widget "${def.type}": invalid span range`);
  }
  const defaultSpan = Math.min(
    maxSpan,
    Math.max(minSpan, def.defaultSpan ?? minSpan),
  );
  for (const id of def.allowedIn ?? []) {
    if (!OVERVIEW_PAGE_ID_PATTERN.test(id)) {
      throw new Error(`widget "${def.type}": invalid allowedIn id "${id}"`);
    }
  }
  assertWidgetOptionFields(def.type, def.options);
  return Object.freeze({
    ...def,
    options: Object.freeze([...def.options]),
    version,
    defaultSpan,
    minSpan,
    maxSpan,
  });
}

/** Holds widget definitions by type. */
export class WidgetRegistry {
  readonly #widgets = new Map<string, RegisteredWidget>();

  /**
   * Register a widget. Registering the same type again throws unless
   * `replace` is set; returns a disposer that removes this registration.
   */
  register<Data>(
    def: WidgetDefinition<Data>,
    options: { replace?: boolean } = {},
  ): () => void {
    const registered = toRegistered(def as unknown as WidgetDefinition);
    if (this.#widgets.has(def.type) && !options.replace) {
      throw new Error(`registerWidget: "${def.type}" is already registered`);
    }
    this.#widgets.set(def.type, registered);
    return () => {
      if (this.#widgets.get(def.type) === registered) {
        this.#widgets.delete(def.type);
      }
    };
  }

  get(type: string): RegisteredWidget | undefined {
    return this.#widgets.get(type);
  }

  has(type: string): boolean {
    return this.#widgets.has(type);
  }

  /** Registered types in registration order. */
  types(): string[] {
    return [...this.#widgets.keys()];
  }

  list(): RegisteredWidget[] {
    return [...this.#widgets.values()];
  }
}

/** Create an isolated registry (tests, or an app with several surfaces). */
export function createWidgetRegistry(): WidgetRegistry {
  return new WidgetRegistry();
}

/** The registry overview components and loaders use unless given another. */
export const defaultWidgetRegistry: WidgetRegistry = createWidgetRegistry();

/** Register a widget type on the default registry. */
export function registerWidget<Data>(
  def: WidgetDefinition<Data>,
  options?: { replace?: boolean },
): () => void {
  return defaultWidgetRegistry.register(def, options);
}

/** A resolved component for each widget type that has one. */
export type WidgetComponents = Map<string, Component<WidgetComponentProps>>;

function isModule(
  value: WidgetComponentModule<unknown>,
): value is { default: Component<WidgetComponentProps<unknown>> } {
  return typeof value === 'object' && value !== null && 'default' in value;
}

/**
 * Resolve the components for `types`: eager components as is, lazy ones by
 * awaiting `loadComponent`. Call it in a universal page load (or before
 * mount) so the grid can render every widget synchronously on the server and
 * hydrate without a mismatch; a type that fails to resolve is left out and
 * renders as unavailable.
 */
export async function resolveWidgetComponents(
  types: Iterable<string>,
  registry: WidgetRegistry = defaultWidgetRegistry,
): Promise<WidgetComponents> {
  const out: WidgetComponents = new Map();
  await Promise.all(
    [...new Set(types)].map(async (type) => {
      const def = registry.get(type);
      if (!def) return;
      if (def.component) {
        out.set(type, def.component as Component<WidgetComponentProps>);
        return;
      }
      if (!def.loadComponent) return;
      try {
        const loaded = await def.loadComponent();
        out.set(
          type,
          (isModule(loaded)
            ? loaded.default
            : loaded) as Component<WidgetComponentProps>,
        );
      } catch {
        // Left out: the grid shows the widget as unavailable.
      }
    }),
  );
  return out;
}
