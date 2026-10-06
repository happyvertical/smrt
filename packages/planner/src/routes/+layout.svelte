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
import { selection } from '$lib/planner/selection.svelte.ts';
import { SELECTION_PARAM, selectionQuery } from '$lib/planner/selection.ts';
import type { LayoutProps } from './$types';

let { children }: LayoutProps = $props();

// The seam for live objects: swap this for a collection-backed DataSource.
provideDataSource(createMemoryDataSource());

const nav: ShellNavItem[] = $derived([
  { href: selection.href('/'), label: 'Planner' },
]);

const navGroups: ShellNavGroup[] = $derived(
  selection.ids.flatMap((id) => {
    const pkg = getPackage(id);
    if (!pkg) return [];
    return [
      {
        heading: humanize(pkg.id),
        items: [
          {
            href: selection.href(`/packages/${pkg.id}/`),
            label: 'What you get',
          },
          ...exposedModels(pkg).map((model) => ({
            href: selection.href(`/m/${pkg.id}/${model.name}/`),
            label: model.name,
          })),
        ],
      },
    ];
  }),
);

// The URL carries the selection so a mock-up can be shared. Pages are
// prerendered, so the query is only read in the browser, after navigation.
let ready = false;

function syncUrl() {
  const wanted = selectionQuery(selection.ids);
  if (location.search !== wanted) {
    replaceState(`${location.pathname}${wanted}${location.hash}`, page.state);
  }
}

afterNavigate((navigation) => {
  if (new URLSearchParams(location.search).has(SELECTION_PARAM)) {
    selection.fromSearch(location.search);
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
  void selection.ids;
  if (ready) syncUrl();
});
</script>

<AppShell
  title="smrt planner"
  subtitle="Pick packages, watch the app assemble"
  {nav}
  {navGroups}
  currentHref={page.url.pathname + selectionQuery(selection.ids)}
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
