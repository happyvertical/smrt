<script lang="ts">
import { ShellLayoutEditor } from '@happyvertical/smrt-svelte/workspace';
import { Button } from '@happyvertical/smrt-ui';
import { Alert, ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { downloadBlueprint } from '$lib/blueprint/file.ts';
import { blueprintStore } from '$lib/blueprint/store.svelte.ts';
import type { Blueprint } from '$lib/blueprint/types.ts';
import { parseBlueprintText } from '$lib/blueprint/validate.ts';
import { recipesById } from '$lib/recipes/index.ts';

let fileInput: HTMLInputElement | undefined = $state();
/** A validated import waiting for the visitor's confirmation. */
let pending = $state<Blueprint | null>(null);
let error = $state('');
let notice = $state('');
let confirmingReset = $state(false);

const current = $derived(blueprintStore.snapshot());

const describe = (b: Blueprint) =>
  `${b.recipes.length} ${b.recipes.length === 1 ? 'recipe' : 'recipes'}, ${b.policies.length} saved ${b.policies.length === 1 ? 'option' : 'options'}`;

async function choose(event: Event & { currentTarget: HTMLInputElement }) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  error = '';
  notice = '';
  if (!file) return;
  try {
    const result = parseBlueprintText(await file.text());
    if (result.ok) pending = result.blueprint;
    else error = result.error;
  } catch {
    error = 'The file could not be read.';
  }
  // Allow choosing the same file again.
  input.value = '';
}

function confirmImport() {
  if (pending) {
    blueprintStore.replace(pending);
    notice = `Imported ${describe(pending)}.`;
  }
  pending = null;
}

function confirmReset() {
  blueprintStore.reset();
  confirmingReset = false;
  notice = 'Blueprint reset.';
}
</script>

<svelte:head>
  <title>Blueprint · smrt planner</title>
</svelte:head>

<main>
  <header>
    <h1>Blueprint</h1>
    <p class="meta">
      Your recipes, their options and the layout, kept together in this browser. Export them
      as a file, or import one to replace what is here. Sample records are not
      part of it.
    </p>
  </header>

  <section aria-labelledby="current-heading">
    <h2 id="current-heading">Current blueprint</h2>
    <p>{describe(current)}.</p>
    {#if current.recipes.length}
      <ul>
        {#each current.recipes as id (id)}
          <li>{recipesById.get(id)?.label ?? id}</li>
        {/each}
      </ul>
    {/if}
  </section>

  <div class="actions">
    <Button onclick={() => downloadBlueprint(blueprintStore.snapshot())}>Export</Button>
    <Button variant="secondary" onclick={() => fileInput?.click()}>Import…</Button>
    <Button variant="secondary" onclick={() => (confirmingReset = true)}>Reset</Button>
    <input
      bind:this={fileInput}
      type="file"
      accept="application/json,.json"
      hidden
      aria-label="Blueprint file"
      onchange={choose}
    />
  </div>

  <section aria-labelledby="layout-heading">
    <h2 id="layout-heading">Layout</h2>
    <p class="meta">
      Reorder, move or hide navigation entries and choose which panels show. The
      layout is saved with the blueprint.
    </p>
    <ShellLayoutEditor />
  </section>

  {#if error}
    <Alert variant="error" title="Import failed">{error}</Alert>
  {/if}
  <p class="notice" role="status" aria-live="polite">{notice}</p>
</main>

<ConfirmDialog
  open={pending !== null}
  title="Replace the current blueprint?"
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
  title="Reset the blueprint?"
  message="This removes every recipe and saved option. Export first to keep a copy."
  confirmLabel="Reset"
  destructive
  onconfirm={confirmReset}
  oncancel={() => (confirmingReset = false)}
/>

<style>
  main {
    display: grid;
    gap: var(--smrt-spacing-4);
    width: min(100%, 72rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6);
  }

  h1,
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
