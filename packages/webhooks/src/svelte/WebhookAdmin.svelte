<script lang="ts">
import { Alert } from '@happyvertical/smrt-ui/feedback';
import { Input } from '@happyvertical/smrt-ui/forms';
import { Button, Card } from '@happyvertical/smrt-ui/ui';
import type {
  WebhookDeliveryRecord,
  WebhookSubscriptionRecord,
} from '../types.js';

interface Props {
  subscriptions: WebhookSubscriptionRecord[];
  deliveries: WebhookDeliveryRecord[];
  onCreate: (input: {
    url: string;
    events: string[];
    models: string[];
    secret: string;
  }) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onReplay: (id: string) => Promise<void>;
}
let { subscriptions, deliveries, onCreate, onToggle, onReplay }: Props =
  $props();
const uid = $props.id();
let url = $state('');
let events = $state('create,update,delete');
let models = $state('');
let secret = $state('');
let error = $state('');
let busy = $state(false);
const split = (value: string) =>
  value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
async function action(callback: () => Promise<void>) {
  if (busy) return;
  busy = true;
  error = '';
  try {
    await callback();
  } catch {
    error = 'The webhook operation could not be completed. Please try again.';
  } finally {
    busy = false;
  }
}
async function submit() {
  await action(async () => {
    await onCreate({
      url,
      events: split(events),
      models: split(models),
      secret,
    });
    url = '';
    secret = '';
  });
}
</script>
<Card>
  <section aria-labelledby={`${uid}-title`} aria-busy={busy}>
    <h2 id={`${uid}-title`}>Outbound webhooks</h2>
    <form onsubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label for={`${uid}-url`}>Endpoint</label>
      <Input id={`${uid}-url`} bind:value={url} type="url" required placeholder="https://partner.example/webhooks" disabled={busy} />
      <label for={`${uid}-events`}>Events</label>
      <Input id={`${uid}-events`} bind:value={events} disabled={busy} />
      <label for={`${uid}-models`}>Models</label>
      <Input id={`${uid}-models`} bind:value={models} disabled={busy} />
      <p>Use comma-separated names. Empty filters match all events or models.</p>
      <label for={`${uid}-secret`}>Signing secret</label>
      <Input id={`${uid}-secret`} bind:value={secret} type="password" required minlength={32} autocomplete="new-password" interaction={false} disabled={busy} />
      <Button type="submit" disabled={busy} loading={busy}>Add subscription</Button>
    </form>
    {#if error}<Alert variant="error">{error}</Alert>{/if}
    <h3>Subscriptions</h3>
    <ul aria-label="Webhook subscriptions">
      {#each subscriptions as subscription (subscription.id)}
        <li><code>{subscription.url}</code>
          <Button disabled={busy} aria-label={`${subscription.enabled ? 'Disable' : 'Enable'} ${subscription.url}`} onclick={() => action(() => onToggle(subscription.id, !subscription.enabled))}>
            {subscription.enabled ? 'Disable' : 'Enable'}
          </Button>
        </li>
      {:else}<li>No subscriptions yet.</li>{/each}
    </ul>
    <h3>Delivery log</h3>
    <div class="table-scroll">
      <table>
        <caption>Recent webhook deliveries</caption>
        <thead><tr><th scope="col">Delivery</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Response</th><th scope="col">Actions</th></tr></thead>
        <tbody>{#each deliveries as delivery (delivery.id)}
          <tr><td>{delivery.id}</td><td>{delivery.status}</td><td>{delivery.attempts}</td><td>{delivery.responseStatus ?? '—'}</td><td>
            {#if delivery.status === 'failed'}<Button disabled={busy} onclick={() => action(() => onReplay(delivery.id))}>Retry delivery</Button>{/if}
          </td></tr>
        {:else}<tr><td colspan="5">No deliveries yet.</td></tr>{/each}</tbody>
      </table>
    </div>
  </section>
</Card>
<style>
  form { display: grid; gap: var(--smrt-space-2, 0.5rem); }
  li { display: flex; gap: var(--smrt-space-2, 0.5rem); align-items: center; flex-wrap: wrap; }
  code { overflow-wrap: anywhere; }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; text-align: left; }
  th, td { padding: var(--smrt-space-2, 0.5rem); }
</style>
