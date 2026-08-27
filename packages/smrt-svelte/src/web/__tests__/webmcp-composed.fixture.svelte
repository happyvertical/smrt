<script lang="ts">
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import type {
  RegisterWebMcpToolsOptions,
  WebMcpToolDefinition,
} from '@happyvertical/smrt-web';
import Provider from '../../Provider.svelte';
import type { WebMcpProviderConfig } from '../webmcp-provider.js';
import Child from './webmcp-composed.child.fixture.svelte';

let {
  dataSurfaceRegistry,
  generatedDefinitions = [],
  fetchFn,
  showChild = true,
}: {
  dataSurfaceRegistry: DataSurfaceRegistry;
  generatedDefinitions?: readonly WebMcpToolDefinition[];
  fetchFn?: RegisterWebMcpToolsOptions['fetchFn'];
  showChild?: boolean;
} = $props();

let cachedDefinitions: readonly WebMcpToolDefinition[] | undefined;
let cachedFetchFn: RegisterWebMcpToolsOptions['fetchFn'] | undefined;
let cachedRegistry: DataSurfaceRegistry | undefined;
let cachedWebmcp: WebMcpProviderConfig | undefined;
const webmcp = $derived.by(() => {
  if (
    cachedWebmcp &&
    cachedDefinitions === generatedDefinitions &&
    cachedFetchFn === fetchFn &&
    cachedRegistry === dataSurfaceRegistry
  ) {
    return cachedWebmcp;
  }
  cachedDefinitions = generatedDefinitions;
  cachedFetchFn = fetchFn;
  cachedRegistry = dataSurfaceRegistry;
  cachedWebmcp = {
    definitions: generatedDefinitions,
    ...(fetchFn ? { fetchFn } : {}),
    ui: { dataSurfaceRegistry },
  };
  return cachedWebmcp;
});
</script>

<Provider {webmcp}>
  {#if showChild}
    <Child {dataSurfaceRegistry} />
  {/if}
</Provider>
