<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import DeliveryStatus from './DeliveryStatus.svelte';
import type {
  DeliveryEventView,
  DevelopmentRequestView,
} from './delivery-types.js';
import { M } from './i18n.js';

export interface Props {
  /** Development request to display. */
  request: DevelopmentRequestView;
  /** Timeline of delivery status events. */
  events?: DeliveryEventView[];
}

let { request, events = [] }: Props = $props();
const { t } = useI18n();
</script>

<article
  class="smrt-development-request-detail__root"
  aria-label={t(M['projects.development_request.detail_aria'])} data-smrt-component="DevelopmentRequestDetail"
>
  <header>
    <div>
      <span>{request.type}</span>
      <h2>{request.title ?? request.description}</h2>
    </div>
    <strong>{request.deliveryStatus ?? request.status}</strong>
  </header>

  {#if request.title}<p>{request.description}</p>{/if}

  <dl>
    <div>
      <dt>{t(M['projects.development_request.status'])}</dt>
      <dd>{request.deliveryStatus ?? request.status}</dd>
    </div>
    {#if request.visibility}
      <div>
        <dt>{t(M['projects.development_request.visibility'])}</dt>
        <dd>{request.visibility}</dd>
      </div>
    {/if}
    {#if request.requesterLabel}
      <div>
        <dt>{t(M['projects.development_request.requester'])}</dt>
        <dd>{request.requesterLabel}</dd>
      </div>
    {/if}
  </dl>

  {#if events.length > 0}<DeliveryStatus {events} />{/if}
</article>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-development-request-detail__root {
    display: grid;
    gap: var(--smrt-spacing-5);
  }
  header {
    align-items: start;
    display: flex;
    gap: var(--smrt-spacing-5);
    justify-content: space-between;
    padding-bottom: var(--smrt-spacing-4);
  }
  header div {
    display: grid;
    gap: var(--smrt-spacing-1);
  }
  h2,
  p,
  dl,
  dd {
    margin: 0;
  }
  dl {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-5);
  }
  dl div {
    display: grid;
    gap: var(--smrt-spacing-1);
  }
}

@layer smrt.theme {
  header {
    border-bottom: var(--smrt-hairline);
  }
  header span,
  dt {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size);
  }
}

</style>
