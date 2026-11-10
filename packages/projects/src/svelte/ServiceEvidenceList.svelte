<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { ServiceEvidenceView } from './delivery-types.js';
import { M } from './i18n.js';

export interface Props {
  /** Service evidence entries showing participant charge and compensation details. */
  entries?: ServiceEvidenceView[];
}

let { entries = [] }: Props = $props();
const { t } = useI18n();

/**
 * Format a minor-units amount for display.
 *
 * Charge and compensation amounts are integer minor units (#2401), so the
 * scale has to be undone before `Intl.NumberFormat`, which expects major units.
 * The currency's own exponent is used rather than a hard-coded 100, so
 * zero-decimal currencies (JPY, KRW) are left alone. The margin below is a
 * subtraction of two integers, so it is exact and needs no tolerance.
 */
const money = (amount = 0, currency = 'USD') => {
  const format = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
  });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(amount / 10 ** digits);
};
</script>

<section
  class="smrt-service-evidence-list__root"
  aria-label={t(M['projects.service_evidence.aria'])} data-smrt-component="ServiceEvidenceList"
>
  {#each entries as entry (entry.id)}
    <article>
      <div>
        <strong>{entry.context}</strong>
        <small>
          {entry.participant} · {entry.durationSeconds === null
            ? (entry.durationHours ?? '—')
            : (entry.durationSeconds / 3600).toFixed(2)} h ·
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-service-evidence-list__root article {
    align-items: center;
    display: grid;
    gap: var(--smrt-spacing-4);
    grid-template-columns: 1fr auto;
    padding: var(--smrt-spacing-4) var(--smrt-spacing-1);
  }
  .smrt-service-evidence-list__root article > div {
    display: grid;
    gap: var(--smrt-spacing-1);
  }
  .smrt-service-evidence-list__root dl {
    display: flex;
    gap: var(--smrt-spacing-5);
    margin: 0;
  }
  .smrt-service-evidence-list__root dl div {
    display: grid;
    gap: var(--smrt-spacing-1);
  }
  .smrt-service-evidence-list__root dd {
    margin: 0;
  }
  @media (max-width: 40rem) {
    .smrt-service-evidence-list__root article {
      grid-template-columns: 1fr;
    }
    .smrt-service-evidence-list__root dl {
      justify-content: space-between;
    }
  }
}

@layer smrt.theme {
  .smrt-service-evidence-list__root {
    border-top: var(--smrt-hairline);
  }
  .smrt-service-evidence-list__root article {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-service-evidence-list__root small,
  .smrt-service-evidence-list__root dt {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-service-evidence-list__root dl div {
    text-align: right;
  }
  .smrt-service-evidence-list__root dt {
    font-size: var(--smrt-typography-label-medium-size);
  }
  .smrt-service-evidence-list__root dd {
    font-variant-numeric: tabular-nums;
  }
  @media (max-width: 40rem) {
    .smrt-service-evidence-list__root dl div {
      text-align: left;
    }
  }
}

</style>
