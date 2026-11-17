<script lang="ts">
import RecordForm from '$lib/components/RecordForm.svelte';
import RelatedRecords from '$lib/components/RelatedRecords.svelte';
import { recordLabel } from '$lib/ui/fields';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const description = $derived(data.description);
const info = $derived(description?.models[data.model]);
</script>

<svelte:head><title>{info ? recordLabel(info, data.record) : data.model}</title></svelte:head>

{#if description && info}
  <div class="smrt-app-shell__page">
    <header class="smrt-app-shell__head">
      <div>
        <h1>{recordLabel(info, data.record)}</h1>
        <p class="smrt-app-shell__sub">{info.label}</p>
      </div>
    </header>
    <RecordForm
      model={data.model}
      {description}
      record={data.record}
      references={data.references}
    />
    <RelatedRecords
      model={data.model}
      {description}
      record={data.record}
      related={data.related}
      references={data.relatedReferences}
    />
  </div>
{/if}
