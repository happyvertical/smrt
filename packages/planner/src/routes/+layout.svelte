<script lang="ts">
import { AppShell } from '@happyvertical/smrt-svelte/app';
import {
  ShellDockTool,
  type ShellNavGroup,
  type ShellNavItem,
} from '@happyvertical/smrt-svelte/workspace';
import { afterNavigate, replaceState } from '$app/navigation';
import { page } from '$app/state';
import { exposedModels, getPackage } from '$lib/catalog/index.ts';
import ChatDockPlaceholder from '$lib/components/ChatDockPlaceholder.svelte';
import { provideDataSource } from '$lib/data/context.ts';
import { humanize } from '$lib/data/format.ts';
import { createMemoryDataSource } from '$lib/data/source.ts';
import { SAVED_BY_FORMS } from '$lib/forms/stock.ts';
import { appHref, appQuery } from '$lib/planner/app.svelte.ts';
import { hasAppState } from '$lib/planner/query.ts';
import { selection } from '$lib/planner/selection.svelte.ts';
import { recipeNav, recipes, sectionId } from '$lib/recipes/index.ts';
import { recipeState } from '$lib/recipes/state.svelte.ts';
import type { Recipe } from '$lib/recipes/types.ts';
import type { LayoutProps } from './$types';

let { children }: LayoutProps = $props();

// The seam for live objects: swap this for a collection-backed DataSource.
provideDataSource(
  createMemoryDataSource({
    // Fields the views hide still carry their policy default, e.g. the
    // `contractType` that tells an Order from a PurchaseOrder.
    defaults: (model) => recipeState.apply(model).background,
    // Rows that only make sense under a product a form creates start empty.
    empty: SAVED_BY_FORMS,
  }),
);

const nav: ShellNavItem[] = $derived([
  { href: appHref('/'), label: 'Planner' },
]);

// Each added recipe (or group of recipes, such as Products) is a navigation
// section with its `nav` entries, so the app shows Customers and Sales
// Orders, not every model in smrt-commerce. Recipes of one group share their
// entries, so Simple and Clothing give one Products link. Options and Help
// are icons in each page's header, not entries here.
const recipeGroups: ShellNavGroup[] = $derived.by(() => {
  const sections = new Map<string, { heading: string; added: Recipe[] }>();
  for (const id of recipeState.ids) {
    const recipe = recipes.find((r) => r.id === id);
    if (!recipe) continue;
    const key = sectionId(recipe);
    const section = sections.get(key) ?? {
      heading: recipe.group?.label ?? recipe.label,
      added: [],
    };
    section.added.push(recipe);
    sections.set(key, section);
  }
  return [...sections.values()].map(({ heading, added }) => {
    const seen = new Set<string>();
    const entries = added.flatMap((recipe) =>
      recipeNav(recipe).filter((entry) => {
        const key = `${entry.model.id}:${entry.label}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
    return {
      heading,
      items: [
        ...entries.map((entry) => ({
          href: appHref(`/m/${entry.packageId}/${entry.model.name}/`),
          label: entry.label,
        })),
      ],
    };
  });
});

const packageGroups: ShellNavGroup[] = $derived(
  selection.ids.flatMap((id) => {
    const pkg = getPackage(id);
    if (!pkg) return [];
    return [
      {
        heading: humanize(pkg.id),
        items: [
          {
            href: appHref(`/packages/${pkg.id}/`),
            label: 'Overview',
          },
          ...exposedModels(pkg).map((model) => ({
            href: appHref(`/m/${pkg.id}/${model.name}/`),
            label: model.name,
          })),
        ],
      },
    ];
  }),
);

const navGroups: ShellNavGroup[] = $derived([
  ...recipeGroups,
  ...packageGroups,
]);

// The URL carries the selection so a mock-up can be shared. Pages are
// prerendered, so the query is only read in the browser, after navigation.
let ready = false;

function syncUrl() {
  const wanted = appQuery();
  if (location.search !== wanted) {
    replaceState(`${location.pathname}${wanted}${location.hash}`, page.state);
  }
}

afterNavigate((navigation) => {
  if (hasAppState(location.search)) {
    selection.fromSearch(location.search);
    recipeState.fromSearch(location.search);
  }
  // SvelteKit runs the initial 'enter' callbacks before the router counts as
  // started, and replaceState throws until then, so wait one microtask.
  const sync = () => {
    ready = true;
    syncUrl();
  };
  if (navigation.type === 'enter') queueMicrotask(sync);
  else sync();
});

// Keep the address bar in step with the selection as it changes.
$effect(() => {
  // appQuery reads every part of the shareable state, so this tracks them all.
  void appQuery();
  if (ready) syncUrl();
});
</script>

<AppShell
  title="smrt planner"
  subtitle="Add recipes, watch the app assemble"
  {nav}
  {navGroups}
  currentHref={page.url.pathname + appQuery()}
  environment="static demo"
>
  {#snippet dock()}
    <ShellDockTool id="assistant" label="Assistant">
      {#snippet render()}
        <ChatDockPlaceholder />
      {/snippet}
    </ShellDockTool>
  {/snippet}
  {@render children()}
</AppShell>
