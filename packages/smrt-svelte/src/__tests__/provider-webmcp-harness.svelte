<script lang="ts">
import Provider from '../Provider.svelte';
import type { WebMcpProviderConfig } from '../web/webmcp-provider.js';

interface Props {
  webmcp: WebMcpProviderConfig;
}

const { webmcp }: Props = $props();
</script>

<Provider {webmcp}>
  <span></span>
</Provider>
