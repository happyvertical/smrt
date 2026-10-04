<script lang="ts">
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import type { Snippet } from 'svelte';
import { tryGetWebMcpUiContext } from '../../web/webmcp-ui-context.js';

interface Props {
  /** The host's dock snippet; receives the Provider's data-surface registry. */
  dock: Snippet<[DataSurfaceRegistry]>;
}

let { dock }: Props = $props();
// Rendered inside the Provider, so this is the registry mounted routes
// register their surfaces on (when the Provider's WebMCP UI is on).
const ui = tryGetWebMcpUiContext();
const registry = $derived(ui?.dataSurfaceRegistry);
</script>

{#if registry}
  {@render dock(registry)}
{/if}
