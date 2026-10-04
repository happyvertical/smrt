<script lang="ts">
import type { CodeSelectOption } from '../code-select-types.js';
import {
  CountrySelect,
  CurrencySelect,
  Form,
  FormGroup,
  ProvinceSelect,
} from '../index.js';

let {
  kind = 'currency',
  initial = '',
  country = 'CA',
  options,
  readOnly = false,
  disabled = false,
  fieldsetDisabled = false,
  locale = 'en',
}: {
  kind?: 'currency' | 'country' | 'province';
  initial?: string;
  country?: string;
  options?: readonly CodeSelectOption[];
  readOnly?: boolean;
  disabled?: boolean;
  fieldsetDisabled?: boolean;
  locale?: string;
} = $props();
let value = $state(initial);
</script>
<Form id="external" preventDefault={false}><span></span></Form>
<fieldset disabled={fieldsetDisabled}>
<FormGroup label="Code" id="code">
{#if kind === 'currency'}<CurrencySelect id="code" name="code" form="external" required bind:value {options} {readOnly} {disabled} {locale} />
{:else if kind === 'country'}<CountrySelect id="code" name="code" form="external" required bind:value {options} {readOnly} {disabled} {locale} />
{:else}<ProvinceSelect id="code" name="code" form="external" required bind:value {country} {options} {readOnly} {disabled} {locale} />{/if}
</FormGroup>
</fieldset>
<output aria-label="Bound value">{value}</output>
