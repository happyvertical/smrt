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

<ol class="smrt-delivery-status__root" aria-label={t(M['projects.delivery_status.aria'])} data-smrt-component="DeliveryStatus">
  {#each [...events].sort((a, b) => a.sequence - b.sequence) as event (event.id)}
    <li>
      <span class="smrt-delivery-status__marker" data-smrt-part="marker" aria-hidden="true"></span>
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-delivery-status__root {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .smrt-delivery-status__root li {
    display: grid;
    gap: var(--smrt-spacing-3);
    grid-template-columns: 1rem 1fr;
    padding-bottom: var(--smrt-spacing-5);
    position: relative;
  }
  .smrt-delivery-status__root li:not(:last-child)::before {
    height: 100%;
    left: 0.35rem;
    position: absolute;
    top: 0.65rem;
    width: 1px;
  }
  .smrt-delivery-status__marker {
    height: 0.7rem;
    margin-top: var(--smrt-spacing-1);
    width: 0.7rem;
    z-index: 1;
  }
  .smrt-delivery-status__root p {
    margin: var(--smrt-spacing-1) 0;
  }
  .smrt-delivery-status__root li:not(:last-child)::before {
    content: '';
  }
}

@layer smrt.theme {
  .smrt-delivery-status__root li:not(:last-child)::before {
    background: var(--smrt-color-outline-variant);
  }
  .smrt-delivery-status__marker {
    background: var(--smrt-color-primary);
    border-radius: var(--smrt-radius-full);
  }
  .smrt-delivery-status__root time {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-small-size);
  }
}

</style>
