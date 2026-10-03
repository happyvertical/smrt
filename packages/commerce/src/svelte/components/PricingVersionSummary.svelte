<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { PRICING_MESSAGES as M } from '../pricing-i18n.js';
import type { PricingVersionData } from '../pricing-types.js';
import { quoteMinorText } from '../quote-types.js';

export interface Props {
  /** Immutable, authorized version data from the owning application. */
  version: PricingVersionData;
}
const { version }: Props = $props();
const { t } = useI18n();
const amount = (value: number | null) =>
  quoteMinorText({ ...version.total, amountMinor: value }) ??
  t(M['commerce.pricing.unknown']);
</script>

<section class="pricing-summary" aria-label={version.label}>
  <h3>{version.label}</h3>
  <p>{version.counterparty} · {version.status}</p>
  <p><strong>{t(M['commerce.pricing.total'])}: {amount(version.total.amountMinor)} {version.total.currency}</strong></p>
  {#if version.reason}<p>{version.reason}</p>{/if}
  <h4>{t(M['commerce.pricing.sources'])}</h4>
  {#if version.sources?.length}
    <ul>{#each version.sources as source (source.id)}
      <li><span>{source.label}</span><strong>{amount(source.amountMinor)}</strong>
        {#if source.description}<p>{source.description}</p>{/if}
      </li>
    {/each}</ul>
  {:else}<p>{t(M['commerce.pricing.no_sources'])}</p>{/if}
</section>

<style>
.pricing-summary { min-width: 0; overflow-wrap: anywhere; }
.pricing-summary ul { display: grid; gap: var(--smrt-spacing-3); padding-inline-start: var(--smrt-spacing-5); }
.pricing-summary li { min-width: 0; }
.pricing-summary li strong { display: block; }
</style>
