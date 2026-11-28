<script lang="ts">
import RecordForm from '$lib/components/RecordForm.svelte';
import { can } from '$lib/ui/access';
import { singularLabel } from '$lib/ui/fields';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const description = $derived(data.description);
const info = $derived(description?.models[data.model]);
</script>

<svelte:head><title>New {info ? singularLabel(info.label).toLowerCase() : data.model}</title></svelte:head>

{#if description && info}
  <div class="smrt-app-shell__page">
    <header class="smrt-app-shell__head">
      <h1>New {singularLabel(info.label).toLowerCase()}</h1>
    </header>
    {#if can(description, data.model, 'create')}
      <RecordForm
        model={data.model}
        {description}
        references={data.references}
        prefill={data.prefill}
        returnTo={data.returnTo}
      />
    {:else}
      <p class="smrt-app-shell__muted" role="status">You can look at {info.label.toLowerCase()} but not add to them. Ask the owner if you need to.</p>
    {/if}
  </div>
{/if}
