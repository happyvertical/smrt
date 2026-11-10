<script lang="ts">
import RecordForm from '$lib/components/RecordForm.svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const description = $derived(data.description);
const info = $derived(description?.models[data.model]);
</script>

<svelte:head><title>New {info?.label ?? data.model}</title></svelte:head>

{#if description && info}
  <div class="sh-page">
    <header class="sh-head">
      <h1>New {info.label.toLowerCase()}</h1>
    </header>
    <RecordForm
      model={data.model}
      {description}
      references={data.references}
    />
  </div>
{/if}
