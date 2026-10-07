<script lang="ts">
import { Checkbox } from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onMount } from 'svelte';
import CaptionOverlay from '../../../svelte/components/assistant/captions/CaptionOverlay.svelte';
import HeardCaptions from '../../../svelte/components/assistant/captions/HeardCaptions.svelte';
import SpokenCaptions from '../../../svelte/components/assistant/captions/SpokenCaptions.svelte';

let ready = $state(false);
onMount(() => {
  ready = true;
});
let heard = $state(true);
let spoken = $state(true);
let third = $state(false);
let mounted = $state(true);
let words = $state('A short interim phrase.');
</script>

<svelte:head><title>Caption overlay layout fixture</title></svelte:head>

<Checkbox disabled={!ready} bind:checked={heard} label="Heard enabled" />
<Checkbox disabled={!ready} bind:checked={spoken} label="Spoken enabled" />
<Checkbox disabled={!ready} bind:checked={third} label="Third caption" />
<Checkbox disabled={!ready} bind:checked={mounted} label="Overlay mounted" />
<Button disabled={!ready} onclick={() => words = 'Short captions.'}>Short captions</Button>
<Button disabled={!ready} onclick={() => words = 'A growing interim phrase. '.repeat(12)}>Grow captions</Button>
<Button disabled={!ready} onclick={() => words = 'A tall caption phrase. '.repeat(150)}>Tall captions</Button>
{#if mounted}
  <CaptionOverlay>
    <HeardCaptions enabled={heard} interim={words} placement="bottom" />
    <SpokenCaptions enabled={spoken} interim="Assistant playback words." placement="bottom" />
    {#if third}
      <HeardCaptions enabled interim="Another speaker." speakerLabel="Guest said" placement="bottom" />
    {/if}
  </CaptionOverlay>
{/if}
