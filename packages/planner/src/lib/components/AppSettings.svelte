<script lang="ts">
import { NumberInput } from '@happyvertical/smrt-svelte/forms';
import {
  CurrencySelect,
  FieldLabel,
  Input,
  Select,
  Switch,
} from '@happyvertical/smrt-ui/forms';
import {
  defaultTaxCode,
  EXAMPLE_TAX_CODES,
  type SampleTaxCode,
  SEEDED_TAX_CODES,
} from '../data/money.ts';
import { fractionToPercent, percentToFraction } from '../fields/percent.ts';
import type { AppSettings, TaxRounding } from '../settings/app-settings.ts';

interface AppSettingsProps {
  value: AppSettings;
  onchange: (next: AppSettings) => void;
  /** Keeps element ids unique when more than one editor is on the page. */
  idPrefix?: string;
}

let { value, onchange, idPrefix = 'app-settings' }: AppSettingsProps = $props();

/** Suggestions for the payment terms; any text is accepted. */
const TERMS = [
  'Due on receipt',
  'Net 15',
  'Net 30',
  'Net 60',
  '50% deposit, balance on completion',
];

const set = (patch: Partial<AppSettings>) => onchange({ ...value, ...patch });

/** The code new documents default to, from the tax rate (smrt's activation). */
const fallback = $derived(defaultTaxCode(value.taxRate, value.currency));
/** The other codes a line can choose: the seeded ones and the example pack. */
const others = $derived(
  [...SEEDED_TAX_CODES, ...EXAMPLE_TAX_CODES].filter(
    (code) => code.id !== fallback.id,
  ),
);
const rates = (code: SampleTaxCode) =>
  code.components.map((part) => part.name).join(' + ') ||
  `No tax, reported as ${code.kind.replace(/-/g, ' ')}`;
</script>

<div class="settings">
  <div class="field">
    <FieldLabel for="{idPrefix}-currency" label="Currency" />
    <CurrencySelect
      id="{idPrefix}-currency"
      value={value.currency}
      onchange={(event) => set({ currency: event.currentTarget.value })}
    />
  </div>

  <div class="percent">
    <NumberInput
      name="{idPrefix}-tax-rate"
      label="Default tax rate"
      min={0}
      step={0.01}
      value={fractionToPercent(value.taxRate)}
      onchange={(percent) => set({ taxRate: percentToFraction(percent) ?? 0 })}
    />
    <span class="percent-sign" aria-hidden="true">%</span>
  </div>

  <div class="field">
    <FieldLabel for="{idPrefix}-rounding" label="Tax rounding" />
    <Select
      id="{idPrefix}-rounding"
      value={value.taxRounding}
      onchange={(event) =>
        set({ taxRounding: event.currentTarget.value as TaxRounding })}
    >
      <option value="line">Per line</option>
      <option value="document">Once per document</option>
    </Select>
  </div>

  <div class="field switch">
    <Switch
      checked={value.pricesIncludeTax}
      onchange={(event) =>
        set({ pricesIncludeTax: event.currentTarget.checked })}
      label="Prices include tax"
    />
    <small>
      {value.pricesIncludeTax
        ? 'A line’s amount is what the customer pays; tax is part of it.'
        : 'Tax is added on top of each line’s amount.'}
    </small>
  </div>

  <div class="field">
    <FieldLabel for="{idPrefix}-terms" label="Default payment terms" />
    <Input
      id="{idPrefix}-terms"
      type="text"
      list="{idPrefix}-terms-options"
      autocomplete="off"
      placeholder="Not set"
      value={value.paymentTerms}
      oninput={(event) => set({ paymentTerms: event.currentTarget.value })}
    />
    <datalist id="{idPrefix}-terms-options">
      {#each TERMS as term (term)}
        <option value={term}></option>
      {/each}
    </datalist>
  </div>
</div>

<section class="tax-codes" aria-labelledby="{idPrefix}-tax-codes">
  <h3 id="{idPrefix}-tax-codes">Tax codes</h3>
  <p class="meta">
    New documents use <strong>{fallback.name}</strong> ({rates(fallback)}),
    from the default tax rate. A line can choose another code; an exempt
    customer pays none.
  </p>
  <ul>
    {#each others as code (code.id)}
      <li data-tax-code={code.code}>
        <span class="name">{code.name}</span>
        <span class="rates">{rates(code)}</span>
      </li>
    {/each}
  </ul>
  <p class="meta">
    The country codes are smrt’s examples; check they apply before using one.
  </p>
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .settings {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--smrt-spacing-4);
    align-items: end;
  }

  .field {
    display: grid;
    gap: var(--smrt-spacing-1);
  }

  .percent {
    display: flex;
    align-items: flex-end;
    gap: var(--smrt-spacing-2);
  }

  .percent :global(.smrt-number) {
    flex: 1;
  }

  .percent-sign {
    padding-bottom: var(--smrt-spacing-2);
    color: var(--smrt-color-on-surface-variant);
  }

  .switch small,
  .meta {
    color: var(--smrt-color-on-surface-variant);
  }

  .tax-codes {
    display: grid;
    gap: var(--smrt-spacing-2);
    margin-top: var(--smrt-spacing-4);
  }

  .tax-codes h3,
  .tax-codes p {
    margin: 0;
  }

  .tax-codes ul {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    gap: var(--smrt-spacing-1) var(--smrt-spacing-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .tax-codes li {
    display: grid;
  }

  .tax-codes .rates {
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface-variant);
  }
}
</style>
