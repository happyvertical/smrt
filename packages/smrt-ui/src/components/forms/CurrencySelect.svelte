<script lang="ts">
import CodeSelect from './CodeSelect.svelte';
import { currencyOptions } from './code-select-options.js';
import type { CurrencySelectProps } from './code-select-types.js';
export interface Props extends CurrencySelectProps {}
let {
  value = $bindable(''),
  options,
  locale = 'en',
  ...rest
}: Props = $props();
let control: CodeSelect | undefined = $state();
const choices = $derived(options ?? currencyOptions(locale));
/** Focus the active native control. */
export function focus(): void {
  control?.focus();
}
/** Return the actual native control, or null before mounting. */
export function getElement() {
  return control?.getElement() ?? null;
}
</script>
<CodeSelect {...rest} bind:this={control} bind:value options={choices} />
