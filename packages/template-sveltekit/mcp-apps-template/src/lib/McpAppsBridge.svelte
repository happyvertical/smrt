<script lang="ts">
  import { requestOpenAiDisplayMode } from '@happyvertical/smrt-mcp-openai/client';
  import { useMcpApp } from '@happyvertical/smrt-svelte/mcp-apps';

  interface Props {
    /** Exact, application-configured host origin. Never derive this from URL input. */
    hostOrigin: string;
  }

  let { hostOrigin }: Props = $props();
  const app = useMcpApp(() => ({
    appInfo: { name: 'smrt-app', version: '0.1.0' },
    availableDisplayModes: ['inline', 'fullscreen'],
    hostOrigin,
    hostWindow: parent,
  }));

  async function expand() {
    if (app.bridge) await requestOpenAiDisplayMode(app.bridge, 'fullscreen');
  }
</script>

<section aria-labelledby="mcp-apps-title" class="mcp-apps-bridge">
  <h1 id="mcp-apps-title">Items</h1>
  <p>Use this view to review the items your signed-in tenant authorizes.</p>
  {#if app.error}
    <p role="status">Host controls are unavailable; this view remains inline.</p>
  {:else}
    <button type="button" onclick={expand}>Expand view</button>
  {/if}
</section>
