<script lang="ts">
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import Provider from '../../Provider.svelte';
import Child from './surfaces.child.fixture.svelte';

let {
  dataSurfaceRegistry,
  withProvider = true,
  ...childProps
}: {
  dataSurfaceRegistry: DataSurfaceRegistry;
  withProvider?: boolean;
  rows: Array<{ id: string; title: string; status: string; token: string }>;
  navigate: (href: string) => void;
  onContext?: (enabled: boolean) => void;
  create: () => void;
} = $props();
</script>

{#if withProvider}
  <Provider webmcp={{ ui: { dataSurfaceRegistry } }}>
    <Child {...childProps} />
  </Provider>
{:else}
  <Child {...childProps} />
{/if}
