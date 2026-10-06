<script lang="ts">
import { getModel } from '$lib/catalog/index.ts';
import ModelWorkspace from '$lib/components/ModelWorkspace.svelte';
import SurfacePanel from '$lib/components/SurfacePanel.svelte';
import { humanize } from '$lib/data/format.ts';
import { selection } from '$lib/planner/selection.svelte.ts';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const model = $derived(getModel(data.packageId, data.modelName));
</script>

<svelte:head>
  <title>{data.modelName} · {humanize(data.packageId)} · smrt planner</title>
</svelte:head>

{#if model}
  <main>
    <nav aria-label="Breadcrumb">
      <a href={selection.href(`/packages/${data.packageId}/`)}>
        {humanize(data.packageId)}
      </a>
      / {model.name}
      {#if !selection.has(data.packageId)}
        <span class="meta">(not in your app yet)</span>
      {/if}
    </nav>

    <ModelWorkspace {model} />

    <section>
      <h2>Fields</h2>
      <table>
        <thead>
          <tr><th>Field</th><th>Type</th><th>Required</th></tr>
        </thead>
        <tbody>
          {#each model.fields as field (field.name)}
            <tr>
              <td><code>{field.name}</code></td>
              <td>
                {field.type}{#if field.related}
                  → {field.related.split(':').pop()}{/if}
              </td>
              <td>{field.required ? 'yes' : ''}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>

    <SurfacePanel models={[model]} />
  </main>
{/if}

<style>
  main {
    display: grid;
    gap: var(--smrt-spacing-6);
    width: min(100%, 72rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6);
  }

  h2 {
    margin: 0 0 var(--smrt-spacing-2);
  }

  .meta {
    color: var(--smrt-color-on-surface-variant);
  }

  table {
    border-collapse: collapse;
  }

  th,
  td {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-4) var(--smrt-spacing-1) 0;
    text-align: left;
  }
</style>
