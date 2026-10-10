<script lang="ts">
import WebhookAdmin from '../src/svelte/WebhookAdmin.svelte';
import type { WebhookSubscriptionRecord } from '../src/types.js';
let subscriptions = $state<WebhookSubscriptionRecord[]>([]);
let fail = $state(false);
let deliveries = $state([{ id: 'delivery-1', tenantId: 'a', subscriptionId: 'sub-1', eventId: 'event', status: 'failed', attempts: 5, responseStatus: 503, error: null }]);
</script>
<label><input type="checkbox" bind:checked={fail} /> Fail operations</label>
<WebhookAdmin {subscriptions} {deliveries}
  onCreate={async ({ secret: _secret, ...input }) => { if (fail) throw new Error('private failure'); subscriptions = [...subscriptions, { ...input, id: 'sub-1', tenantId: 'a', enabled: true }]; }}
  onToggle={async (id, enabled) => { if (fail) throw new Error('private failure'); subscriptions = subscriptions.map((s) => s.id === id ? { ...s, enabled } : s); }}
  onReplay={async () => { if (fail) throw new Error('private failure'); deliveries = deliveries.map((d) => ({ ...d, status: 'pending' })); }} />
