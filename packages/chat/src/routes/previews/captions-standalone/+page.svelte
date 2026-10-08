<script lang="ts">
import { Checkbox } from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
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
const tall = $derived(page.url.searchParams.has('tall'));
let short = $state(false);
let mounted = $state(true);
</script>

<svelte:head><title>Standalone caption containment</title></svelte:head>

{#if tall}
  <Checkbox bind:checked={mounted} label="Caption mounted" />
  <Button onclick={() => short = true}>Short caption</Button>
{/if}
{#if mounted}
  {#if page.url.searchParams.get('speaker') === 'spoken'}
    <SpokenCaptions enabled {placement} interim={tall ? '' : interim} lines={tall
      ? Array.from({ length: short ? 1 : 3 }, (_, i) => ({ id: String(i), text: short ? 'Short final.' : finalText.repeat(5), speaker: 'spoken' as const, createdAt: i }))
      : [{ id: 'final', text: finalText, speaker: 'spoken', createdAt: 0 }]} />
  {:else}
    <HeardCaptions enabled {placement} interim={tall ? (short ? 'Short interim.' : interim.repeat(10)) : interim} lines={tall ? [] : [{ id: 'final', text: finalText, speaker: 'heard', createdAt: 0 }]} />
  {/if}
{/if}
