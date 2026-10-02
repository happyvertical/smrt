<script lang="ts">
import { onDestroy } from 'svelte';
import Icon from '../src/components/display/Icon.svelte';
import { registerIcons } from '../src/components/display/icons.svelte.js';

const names = ['alert', 'warning', 'info', 'home', 'user', 'settings', 'trash', 'edit', 'calendar', 'clock', 'camera', 'upload', 'download'];
let cleanup: (() => void) | undefined;
onDestroy(() => cleanup?.());
</script>
<button type="button" onclick={() => { cleanup?.(); cleanup = registerIcons({ 'shop-machine': 'M4 4h16v16H4z' }); }}>Register shop icons</button>
<button type="button" onclick={() => cleanup?.()}>Remove shop icons</button>
<Icon name="shop-machine" aria-label="Shop machine" />
{#each names as name}<Icon {name} aria-label={name} />{/each}
