<script lang="ts">
import { NumberInput } from '@happyvertical/smrt-svelte/forms';
import {
  CurrencySelect,
  FieldLabel,
  Input,
} from '@happyvertical/smrt-ui/forms';
import { fractionToPercent, percentToFraction } from '../fields/percent.ts';
import type { AppSettings } from '../settings/app-settings.ts';

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

<style>
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
</style>
