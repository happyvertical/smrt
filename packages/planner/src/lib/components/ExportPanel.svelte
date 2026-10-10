<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import { Alert, ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { downloadCookbook } from '$lib/cookbook/file.ts';
import { cookbookStore } from '$lib/cookbook/store.svelte.ts';
import type { Cookbook } from '$lib/cookbook/types.ts';
import { parseCookbookText } from '$lib/cookbook/validate.ts';
import { useDataSource } from '$lib/data/context.ts';
import { humanize } from '$lib/data/format.ts';
import { getLibraryCookbook } from '$lib/library/index.ts';
import { libraryState } from '$lib/library/state.svelte.ts';
import { recipesById } from '$lib/recipes/index.ts';

let fileInput: HTMLInputElement | undefined = $state();
/** A validated import waiting for the visitor's confirmation. */
let pending = $state<Cookbook | null>(null);
/** What reading the pending import dropped (invalid page customisations). */
let pendingDropped = $state<string[]>([]);
let error = $state('');
let notice = $state('');
let confirmingReset = $state(false);

// A file is named for the library cookbook last applied, else a generic name.
const exportName = () => getLibraryCookbook(libraryState.active ?? '')?.name;

const current = $derived(cookbookStore.snapshot());

const pages = (b: Cookbook) => Object.keys(b.overviews ?? {}).length;

const describe = (b: Cookbook) =>
  `${b.recipes.length} ${b.recipes.length === 1 ? 'recipe' : 'recipes'}, ${b.features.length} ${b.features.length === 1 ? 'feature' : 'features'}, ${b.policies.length} saved ${b.policies.length === 1 ? 'option' : 'options'}${pages(b) ? `, ${pages(b)} customised ${pages(b) === 1 ? 'page' : 'pages'}` : ''}`;

async function choose(event: Event & { currentTarget: HTMLInputElement }) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  error = '';
  notice = '';
  if (!file) return;
  try {
    const result = parseCookbookText(await file.text());
    if (result.ok) {
      pending = result.cookbook;
      pendingDropped = result.dropped ?? [];
    } else error = result.error;
  } catch {
    error = 'The file could not be read.';
  }
  // Allow choosing the same file again.
  input.value = '';
}

function confirmImport() {
  if (pending) {
    cookbookStore.replace(pending);
    notice = `Imported ${describe(pending)}.${pendingDropped.length ? ` Not imported: ${pendingDropped.join(' ')}` : ''}`;
  }
  pending = null;
  pendingDropped = [];
}

const dataSource = useDataSource();

function confirmReset() {
  cookbookStore.reset();
  // Rows the visitor added, edited or deleted go with the cookbook.
  dataSource.reset?.();
  confirmingReset = false;
  // The shell holds its settings in memory too; reload so it starts from its
  // defaults (the cookbook is already saved empty).
  cookbookStore.flush();
  location.reload();
}
</script>

<div class="export">
  <p class="meta">
    Your recipes, their options, the layout and customised pages, kept together in this browser.
    Export them as a file, or import one to replace what is here. Sample
    records are not part of it.
  </p>
  <section aria-labelledby="current-heading">
    <h2 id="current-heading">Current cookbook</h2>
    <p>{describe(current)}.</p>
    {#if current.recipes.length}
      <ul>
        {#each current.recipes as id (id)}
          <li>{recipesById.get(id)?.label ?? id}</li>
        {/each}
      </ul>
    {/if}
    {#if current.features.length}
      <ul>
        {#each current.features as id (id)}
          <li>{humanize(id.slice(id.lastIndexOf(':') + 1))}</li>
        {/each}
      </ul>
    {/if}
  </section>

  <div class="actions">
    <Button onclick={() => downloadCookbook(cookbookStore.snapshot(), exportName())}>Export cookbook</Button>
    <Button variant="secondary" onclick={() => fileInput?.click()}>Import cookbook…</Button>
    <Button variant="secondary" onclick={() => (confirmingReset = true)}>Reset</Button>
    <input
      bind:this={fileInput}
      type="file"
      accept="application/json,.json"
      hidden
      aria-label="Cookbook file"
      onchange={choose}
    />
  </div>

  {#if error}
    <Alert variant="error" title="Import failed">{error}</Alert>
  {/if}
  <p class="notice" role="status" aria-live="polite">{notice}</p>
</div>

<ConfirmDialog
  open={pending !== null}
  title="Replace the current cookbook?"
  message={pending
    ? `Importing replaces your ${describe(current)} with ${describe(pending)}.`
    : ''}
  confirmLabel="Replace"
  destructive
  onconfirm={confirmImport}
  oncancel={() => (pending = null)}
/>

<ConfirmDialog
  open={confirmingReset}
  title="Reset the cookbook?"
  message="This removes every recipe and saved option, and the sample records you added or changed. Export first to keep a copy."
  confirmLabel="Reset"
  destructive
  onconfirm={confirmReset}
  oncancel={() => (confirmingReset = false)}
/>

<style>
  .export {
    display: grid;
    gap: var(--smrt-spacing-4);
  }

  h2,
  p {
    margin: 0;
  }

  .meta,
  .notice {
    color: var(--smrt-color-on-surface-variant);
  }

  .notice:empty {
    display: none;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
  }
</style>
