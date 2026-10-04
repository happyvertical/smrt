<script lang="ts">
import type { McpAppState } from '../src/mcp-apps/index.js';
import { McpAppsBridge } from '../src/mcp-apps/index.js';

function expose(app: McpAppState) {
  Object.assign(window, { bridgeComponent: app });
  return '';
}
</script>
<McpAppsBridge
  hostOrigin="http://127.0.0.1:47851"
  appInfo={{ name: 'Bridge component fixture', version: '1' }}
  title="Items"
  description="Review the items your signed-in tenant authorizes."
>
  {#snippet children(app)}
    {expose(app)}<p>State: {app.snapshot?.state ?? 'mounting'}</p>
  {/snippet}
</McpAppsBridge>
