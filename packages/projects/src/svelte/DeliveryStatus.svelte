<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { DeliveryEventView } from './delivery-types.js';
import { M } from './i18n.js';

export interface Props {
  /** Timeline of delivery status events. */
  events?: DeliveryEventView[];
}

let { events = [] }: Props = $props();
const { t } = useI18n();
const format = (value: Date | string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
</script>

<ol class="delivery" aria-label={t(M['projects.delivery_status.aria'])}>
  {#each [...events].sort((a, b) => a.sequence - b.sequence) as event (event.id)}
    <li>
      <span class="marker" aria-hidden="true"></span>
      <div>
        <strong>{event.label ?? event.type.replaceAll('_', ' ')}</strong>
        {#if event.detail}<p>{event.detail}</p>{/if}
        <time datetime={new Date(event.occurredAt).toISOString()}>
          {format(event.occurredAt)}
        </time>
      </div>
    </li>
  {/each}
</ol>

<style>
  .delivery {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .delivery li {
    display: grid;
    gap: var(--smrt-spacing-3);
    grid-template-columns: 1rem 1fr;
    padding-bottom: var(--smrt-spacing-5);
    position: relative;
  }
  .delivery li:not(:last-child)::before {
    background: var(--smrt-color-outline-variant);
    content: '';
    height: 100%;
    left: 0.35rem;
    position: absolute;
    top: 0.65rem;
    width: 1px;
  }
  .marker {
    background: var(--smrt-color-primary);
    border-radius: var(--smrt-radius-full);
    height: 0.7rem;
    margin-top: var(--smrt-spacing-1);
    width: 0.7rem;
    z-index: 1;
  }
  .delivery p {
    margin: var(--smrt-spacing-1) 0;
  }
  .delivery time {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-small-size);
  }
</style>
