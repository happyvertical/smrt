<script lang="ts">
import RecordList from '$lib/components/RecordList.svelte';
import { fieldLabel, recordLabel } from '$lib/ui/fields';
import { formulaWords } from '$lib/ui/formula';
import { modelHref } from '$lib/ui/menu';
import { prefilledNewHref } from '$lib/ui/related';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const description = $derived(data.description);
const info = $derived(description?.models[data.model]);
const filter = $derived(data.filter);
const filterTarget = $derived(
  filter ? data.references[filter.ref]?.find((r) => r.id === filter.id) : null,
);
const filterLabel = $derived(
  filter && filterTarget
    ? recordLabel(description?.models[filter.ref], filterTarget)
    : (filter?.id ?? ''),
);
const newHref = $derived(
  filter
    ? prefilledNewHref(data.model, filter.field, filter.id)
    : `${modelHref(data.model)}/new`,
);
</script>

<svelte:head><title>{info?.label ?? data.model}</title></svelte:head>

{#if description && info}
  <div class="smrt-app-shell__page">
    <header class="smrt-app-shell__head">
      <div>
        <h1>{info.label}</h1>
        <p class="smrt-app-shell__sub">{data.rows.length} {data.rows.length === 1 ? 'record' : 'records'}</p>
      </div>
      <a class="smrt-app-shell__btn smrt-app-shell__btn-primary" href={newHref}>
        New {info.label.toLowerCase()}
      </a>
    </header>
    {#if filter && info}
      <p class="smrt-app-shell__muted" role="status" data-smrt-part="status">
        Showing {info.label.toLowerCase()} for {filterLabel}.
        <a class="smrt-app-shell__link" href={modelHref(data.model)} data-smrt-part="link">Show all</a>
      </p>
    {/if}
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
