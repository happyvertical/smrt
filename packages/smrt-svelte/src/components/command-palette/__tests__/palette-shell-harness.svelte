<script lang="ts">
import AppShell from '../../app/AppShell.svelte';
import CommandPalette from '../CommandPalette.svelte';
import { setCommandPalette } from '../context.js';
import type { CommandPaletteController } from '../controller.svelte.js';
import ProviderChild from './palette-provider-child.svelte';

let {
  palette,
  withChild = false,
}: { palette: CommandPaletteController; withChild?: boolean } = $props();

// svelte-ignore state_referenced_locally
setCommandPalette(palette);
</script>

{#snippet search()}
  <CommandPalette {palette} />
{/snippet}

<AppShell
  title="Test app"
  slotItems={[
    { id: 'item:command-palette', label: 'Search', slot: 'header.center', render: search },
  ]}
>
  <main>Page</main>
  {#if withChild}<ProviderChild />{/if}
</AppShell>
