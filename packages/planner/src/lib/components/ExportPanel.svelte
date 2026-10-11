<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import { Alert, ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { downloadCookbook } from '../cookbook/file.ts';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import type { Cookbook } from '../cookbook/types.ts';
import { parseCookbookText } from '../cookbook/validate.ts';
import { useDataSource } from '../data/context.ts';
import { humanize } from '../data/format.ts';
import { kitchenState } from '../kitchen/state.svelte.ts';
import { getLibraryCookbook } from '../library/index.ts';
import { libraryState } from '../library/state.svelte.ts';
import { recipesById } from '../recipes/index.ts';

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
    {#if kitchenState.config}
      <Button
        disabled={kitchenState.status === 'sending'}
        onclick={() => kitchenState.send(cookbookStore.snapshot())}
      >{kitchenState.status === 'sending' ? 'Sending to kitchen…' : 'Send to kitchen'}</Button>
      <Button variant="secondary" onclick={() => downloadCookbook(cookbookStore.snapshot(), exportName())}>Download cookbook</Button>
    {:else}
      <Button onclick={() => downloadCookbook(cookbookStore.snapshot(), exportName())}>Export cookbook</Button>
    {/if}
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

  {#if kitchenState.needsLink}
    <Alert variant="info" title="Send to kitchen needs its link">
      The kitchen is running, but this page was opened without its one-time
      token. Open the address <code>smrt kitchen</code> printed (it ends in
      <code>#kitchen=…</code>), or download the cookbook and run
      <code>smrt cookbook apply</code> on the file.
    </Alert>
  {/if}
  {#if kitchenState.tokenInConfig}
    <Alert variant="warning" title="Send to kitchen is off">
      This version of <code>smrt kitchen</code> puts its one-time token in a
      file other programs on this computer can read, so the planner does not
      use it. Update the <code>smrt</code> CLI, or download the cookbook and run
      <code>smrt cookbook apply</code> on the file.
    </Alert>
  {/if}
  {#if error}
    <Alert variant="error" title="Import failed">{error}</Alert>
  {/if}
  <p class="notice" role="status" aria-live="polite">{notice}</p>
  {#if kitchenState.outcome}
    <div class="kitchen" role="status" aria-live="polite">
      {#if kitchenState.outcome.ok}
        <Alert variant="success" title="Sent to the kitchen">
          {kitchenState.outcome.result.mode === 'update' ? 'Updated' : 'Created'} the project{kitchenState.outcome.result.dir ? ` in ${kitchenState.outcome.result.dir}` : ''}.
          {#if kitchenState.outcome.result.nextSteps.length}
            Next, in your terminal:
            <ul>
              {#each kitchenState.outcome.result.nextSteps as step (step)}
                <li><code>{step}</code></li>
              {/each}
            </ul>
          {/if}
        </Alert>
      {:else}
        <Alert variant="error" title="The kitchen could not use this cookbook">
          <ul>
            {#each kitchenState.outcome.errors as message (message)}
              <li>{message}</li>
            {/each}
          </ul>
        </Alert>
      {/if}
    </div>
  {/if}
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
