<script lang="ts">
import { page } from '$app/state';
import HeardCaptions from '../../../svelte/components/assistant/captions/HeardCaptions.svelte';
import SpokenCaptions from '../../../svelte/components/assistant/captions/SpokenCaptions.svelte';

// Deliberately no wrapper or styles: containment must belong to the exported
// component, not to the listening workbench's caption container.
const placement = $derived(
  page.url.searchParams.get('placement') === 'inline' ? 'inline' : 'bottom',
);
const finalText = `https://example.test/${'long-url-segment'.repeat(20)}`;
const interim = 'UnbrokenInterimWord'.repeat(20);
</script>

<svelte:head><title>Standalone caption containment</title></svelte:head>

{#if page.url.searchParams.get('speaker') === 'spoken'}
  <SpokenCaptions enabled {placement} {interim} lines={[{ id: 'final', text: finalText, speaker: 'spoken', createdAt: 0 }]} />
{:else}
  <HeardCaptions enabled {placement} {interim} lines={[{ id: 'final', text: finalText, speaker: 'heard', createdAt: 0 }]} />
{/if}
