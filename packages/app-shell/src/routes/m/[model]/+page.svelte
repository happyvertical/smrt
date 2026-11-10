<script lang="ts">
import RecordList from '$lib/components/RecordList.svelte';
import { modelHref } from '$lib/ui/menu';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const description = $derived(data.description);
const info = $derived(description?.models[data.model]);
</script>

<svelte:head><title>{info?.label ?? data.model}</title></svelte:head>

{#if description && info}
  <div class="sh-page">
    <header class="sh-head">
      <div>
        <h1>{info.label}</h1>
        <p class="sh-sub">{data.rows.length} {data.rows.length === 1 ? 'record' : 'records'}</p>
      </div>
      <a class="sh-btn sh-btn-primary" href="{modelHref(data.model)}/new">
        New {info.label.toLowerCase()}
      </a>
    </header>
    <RecordList
      model={data.model}
      {description}
      rows={data.rows}
      references={data.references}
    />
  </div>
{/if}
