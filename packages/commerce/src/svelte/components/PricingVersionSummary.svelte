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
function amount(value: number | null): string {
  try {
    return (
      quoteMinorText({ ...version.total, amountMinor: value }) ??
      t(M['commerce.pricing.unknown'])
    );
  } catch (error) {
    if (error instanceof RangeError) return t(M['commerce.pricing.unknown']);
    throw error;
  }
}
</script>

<section class="smrt-pricing-version-summary__root" aria-label={version.label} data-smrt-component="PricingVersionSummary">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-pricing-version-summary__root {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .smrt-pricing-version-summary__root ul {
    display: grid;
    gap: var(--smrt-spacing-3);
    padding-inline-start: var(--smrt-spacing-5);
  }
  .smrt-pricing-version-summary__root li {
    min-width: 0;
  }
  .smrt-pricing-version-summary__root li strong {
    display: block;
  }
}

@layer smrt.theme {
}

</style>
