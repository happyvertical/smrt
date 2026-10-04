<script lang="ts">
import CodeSelect from './CodeSelect.svelte';
import { countryOptions } from './code-select-options.js';
import type { CountrySelectProps } from './code-select-types.js';
export interface Props extends CountrySelectProps {}
let {
  value = $bindable(''),
  options,
  locale = 'en',
  ...rest
}: Props = $props();
let control: CodeSelect | undefined = $state();
const choices = $derived(options ?? countryOptions(locale));
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
