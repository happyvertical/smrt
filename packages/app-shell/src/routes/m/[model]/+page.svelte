<script lang="ts">
import RecordList from '$lib/components/RecordList.svelte';
import { fieldLabel } from '$lib/ui/fields';
import { formulaWords } from '$lib/ui/formula';
import { modelHref } from '$lib/ui/menu';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const description = $derived(data.description);
const info = $derived(description?.models[data.model]);
</script>

<svelte:head><title>{info?.label ?? data.model}</title></svelte:head>

{#if description && info}
  <div class="smrt-app-shell__page">
    <header class="smrt-app-shell__head">
      <div>
        <h1>{info.label}</h1>
        <p class="smrt-app-shell__sub">{data.rows.length} {data.rows.length === 1 ? 'record' : 'records'}</p>
      </div>
      <a class="smrt-app-shell__btn smrt-app-shell__btn-primary" href="{modelHref(data.model)}/new">
        New {info.label.toLowerCase()}
      </a>
    </header>
    <details class="smrt-app-shell__card"><summary>Fields</summary><dl>
      {#each Object.entries(info.fields) as [name, field] (name)}
        <dt>{fieldLabel(name, field)}{#if field.calculated}{' '}<small class="smrt-app-shell__muted">calculated</small>{/if}</dt>
        <dd>{field.calculated ? formulaWords(field.calculated, info.fields) : field.type}</dd>
      {/each}
    </dl></details>
    <RecordList
      model={data.model}
      {description}
      rows={data.rows}
      references={data.references}
    />
  </div>
{/if}
