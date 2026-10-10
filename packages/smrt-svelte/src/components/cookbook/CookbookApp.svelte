<script lang="ts">
/**
 * `CookbookApp` (#3749): `AppShell` driven by a cookbook. A generated app
 * needs a layout that renders this with `smrt.cookbook.json` (validated) and
 * the catalog the server helper loads, plus one route that renders
 * `CookbookSectionPage`.
 *
 * It builds the navigation, layout, theme and section overviews with
 * `buildCookbookShell`, keeps layout and overview edits in memory, and hands
 * each edit to `oncookbookchange` for the host to persist.
 */
import { createRawSnippet, mount, unmount, untrack } from 'svelte';
import AppShell from '../app/AppShell.svelte';
import type { ShellSlotItem } from '../app/slot-item.js';
import { parseRecipeExportRef } from '../overview/recipe-widgets.js';
import {
  resolveWidgetComponents,
  type WidgetComponents,
  type WidgetRegistry,
} from '../overview/registry.js';
import type { OverviewOverride } from '../overview/types.js';
import {
  isShellLayoutEmpty,
  type ShellLayout,
} from '../workspace/admin-shell/layout.js';
import { applyCookbookTheme } from './brand-theme.js';
import { buildCookbookShell, humanize, pluralize } from './build.js';
import { type CookbookContext, setCookbookContext } from './context.js';
import { createCookbookRegistry } from './registry.js';
import type { CookbookAppProps } from './types.js';

let {
  cookbook,
  catalog,
  loaders,
  widgetContext,
  resolveExport,
  oncookbookchange,
  recipeOrder,
  entryPath,
  sectionPath,
  href,
  title,
  slotItems = [],
  children,
  ...shellProps
}: CookbookAppProps = $props();

const shell = $derived(
  buildCookbookShell({
    cookbook,
    catalog,
    ...(title ? { title } : {}),
    ...(recipeOrder ? { recipeOrder } : {}),
    ...(entryPath ? { entryPath } : {}),
    ...(sectionPath ? { sectionPath } : {}),
    ...(href ? { href } : {}),
    dataWidgets: Boolean(loaders?.metric && loaders?.records),
  }),
);

// Local copies the user edits; they follow the cookbook whenever it changes.
let layout = $state.raw<ShellLayout | null>(untrack(() => shell.layout));
let overrides = $state.raw<Record<string, unknown>>(
  untrack(() => storedOverrides()),
);

function storedOverrides(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(shell.overviews)
      .filter(([, page]) => page.override != null)
      .map(([id, page]) => [id, page.override]),
  );
}

$effect(() => {
  layout = shell.layout;
  overrides = storedOverrides();
});

function emit() {
  if (!oncookbookchange) return;
  const next = { ...cookbook };
  if (isShellLayoutEmpty(layout)) delete next.layout;
  else next.layout = layout as ShellLayout;
  if (Object.keys(overrides).length > 0) {
    next.overviews = overrides as NonNullable<typeof next.overviews>;
  } else delete next.overviews;
  oncookbookchange(next);
}

const preset = $derived(applyCookbookTheme(shell.theme));

// Widget registry: core widgets plus the recipes' `widget` surfaces.
let registry = $state.raw<WidgetRegistry | null>(null);
let components = $state.raw<WidgetComponents>(new Map());

// Keyed by content: an edit rebuilds `shell` but must not rebuild the registry.
const widgetsKey = $derived(JSON.stringify(shell.widgets));
const shellWidgetsKey = $derived(JSON.stringify(shell.shellWidgets));

$effect(() => {
  void widgetsKey;
  const widgets = untrack(() => shell.widgets);
  const resolve = resolveExport;
  const dataLoaders = loaders;
  let cancelled = false;
  void (async () => {
    const created = await createCookbookRegistry({
      ...(dataLoaders ? { loaders: dataLoaders } : {}),
      widgets,
      ...(resolve ? { resolveExport: resolve } : {}),
    });
    const resolved = await resolveWidgetComponents(
      created.registry.list().map((def) => def.type),
      created.registry,
    );
    if (cancelled) return;
    components = resolved;
    registry = created.registry;
  })();
  return () => {
    cancelled = true;
  };
});

// Recipe `shell-widget` surfaces become movable slot items.
let recipeSlotItems = $state.raw<ShellSlotItem[]>([]);

$effect(() => {
  void shellWidgetsKey;
  const widgets = untrack(() => shell.shellWidgets);
  const resolve = resolveExport;
  if (!resolve || widgets.length === 0) {
    recipeSlotItems = [];
    return;
  }
  let cancelled = false;
  void (async () => {
    const items: ShellSlotItem[] = [];
    for (const widget of widgets) {
      const ref = parseRecipeExportRef(widget.export);
      if (!ref) continue;
      try {
        const loaded = (await resolve(ref.specifier, ref.exportName)) as
          | { default?: unknown }
          | ((...args: never[]) => unknown)
          | undefined;
        const component =
          loaded && typeof loaded === 'object' && 'default' in loaded
            ? loaded.default
            : loaded;
        if (typeof component !== 'function') continue;
        items.push({
          id: `recipe:${widget.recipeId}:${ref.exportName}`,
          label: widget.label,
          slot: widget.slot,
          render: createRawSnippet(() => ({
            render: () => '<span data-cookbook-slot-widget></span>',
            setup: (node: Element) => {
              const instance = mount(component as never, {
                target: node as HTMLElement,
              });
              return () => {
                void unmount(instance);
              };
            },
          })),
        });
      } catch {
        // A widget that cannot load is left out; the shell still renders.
      }
    }
    if (!cancelled) recipeSlotItems = items;
  })();
  return () => {
    cancelled = true;
  };
});

const models = $derived.by(() => {
  const seen = new Set<string>();
  const choices: { value: string; label: string }[] = [];
  for (const entry of shell.entries.values()) {
    if (seen.has(entry.model.id)) continue;
    seen.add(entry.model.id);
    choices.push({
      value: entry.model.id,
      label: pluralize(humanize(entry.model.name)),
    });
  }
  return choices;
});

setCookbookContext({
  get shell() {
    return shell;
  },
  get registry() {
    return registry;
  },
  get components() {
    return components;
  },
  get models() {
    return models;
  },
  overrideFor: (id) => overrides[id] ?? null,
  setOverride: (id, override: OverviewOverride | null) => {
    const next = { ...overrides };
    if (override === null) delete next[id];
    else next[id] = override;
    overrides = next;
    emit();
  },
  widgetContext: () => widgetContext?.() ?? {},
} satisfies CookbookContext);
</script>

<AppShell
  {...shellProps}
  title={shell.title}
  navMode="sections"
  navGroups={shell.navGroups}
  {layout}
  onlayoutchange={(next) => {
    layout = next;
    emit();
  }}
  {preset}
  colorScheme={shell.theme.colorScheme}
  sectionHref={(id) => shell.sectionPath(id)}
  slotItems={[...slotItems, ...recipeSlotItems]}
>
  {@render children()}
</AppShell>
