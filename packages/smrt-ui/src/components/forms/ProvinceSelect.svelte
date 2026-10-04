<script lang="ts">
import CodeSelect from './CodeSelect.svelte';
import { provinceOptions } from './code-select-options.js';
import type { ProvinceSelectProps } from './code-select-types.js';
export interface Props extends ProvinceSelectProps {}
let {
  value = $bindable(''),
  options,
  locale = 'en',
  country = '',
  ...rest
}: Props = $props();
let control: CodeSelect | undefined = $state();
const choices = $derived(options ?? provinceOptions(country));
/** Focus the active native control. */
export function focus(): void {
  control?.focus();
}
/** Return the actual native control, or null before mounting. */
export function getElement() {
  return control?.getElement() ?? null;
}
</script>
<CodeSelect {...rest} bind:this={control} bind:value options={choices} freeText={choices === undefined} />
