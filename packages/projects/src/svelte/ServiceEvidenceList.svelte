<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { ServiceEvidenceView } from './delivery-types.js';
import { M } from './i18n.js';

export interface Props {
  entries?: ServiceEvidenceView[];
}

let { entries = [] }: Props = $props();
const { t } = useI18n();

const money = (amount = 0, currency = 'USD') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
    amount,
  );
</script>

<section
  class="evidence"
  aria-label={t(M['projects.service_evidence.aria'])}
>
  {#each entries as entry (entry.id)}
    <article>
      <div>
        <strong>{entry.context}</strong>
        <small>
          {entry.participant} · {(entry.durationSeconds / 3600).toFixed(2)} h ·
          {entry.status}
        </small>
      </div>
      <dl>
        <div>
          <dt>{t(M['projects.service_evidence.client'])}</dt>
          <dd>{money(entry.chargeAmount, entry.currency)}</dd>
        </div>
        <div>
          <dt>{t(M['projects.service_evidence.provider'])}</dt>
          <dd>{money(entry.compensationAmount, entry.currency)}</dd>
        </div>
        <div>
          <dt>{t(M['projects.service_evidence.margin'])}</dt>
          <dd>
            {money(
              (entry.chargeAmount ?? 0) - (entry.compensationAmount ?? 0),
              entry.currency,
            )}
          </dd>
        </div>
      </dl>
    </article>
  {/each}
</section>

<style>
  .evidence {
    border-top: 1px solid var(--smrt-color-outline-variant);
  }
  .evidence article {
    align-items: center;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    display: grid;
    gap: var(--smrt-spacing-4);
    grid-template-columns: 1fr auto;
    padding: var(--smrt-spacing-4) var(--smrt-spacing-1);
  }
  .evidence article > div {
    display: grid;
    gap: var(--smrt-spacing-1);
  }
  .evidence small,
  .evidence dt {
    color: var(--smrt-color-on-surface-variant);
  }
  .evidence dl {
    display: flex;
    gap: var(--smrt-spacing-5);
    margin: 0;
  }
  .evidence dl div {
    display: grid;
    gap: var(--smrt-spacing-1);
    text-align: right;
  }
  .evidence dt {
    font-size: var(--smrt-typography-label-medium-size);
  }
  .evidence dd {
    font-variant-numeric: tabular-nums;
    margin: 0;
  }
  @media (max-width: 40rem) {
    .evidence article {
      grid-template-columns: 1fr;
    }
    .evidence dl {
      justify-content: space-between;
    }
    .evidence dl div {
      text-align: left;
    }
  }
</style>
