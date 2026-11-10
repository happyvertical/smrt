<script lang="ts">
import RecordForm from '$lib/components/RecordForm.svelte';
import { recordLabel } from '$lib/ui/fields';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const description = $derived(data.description);
const info = $derived(description?.models[data.model]);
</script>

<svelte:head><title>{info ? recordLabel(info, data.record) : data.model}</title></svelte:head>

{#if description && info}
  <div class="sh-page">
    <header class="sh-head">
      <div>
        <h1>{recordLabel(info, data.record)}</h1>
        <p class="sh-sub">{info.label}</p>
      </div>
    </header>
    <RecordForm
      model={data.model}
      {description}
      record={data.record}
      references={data.references}
    />
  </div>
{/if}
