<script lang="ts">
import type { ComponentProps } from 'svelte';
import type { CodeSelectProps } from './code-select-types.js';
import FieldLabel from './FieldLabel.svelte';
import Input from './Input.svelte';
import Select from './Select.svelte';

interface Props extends CodeSelectProps {
  /** Internal region fallback for countries without a built-in option list. */
  freeText?: boolean;
}
let {
  value = $bindable(''),
  options = [],
  placeholder = '—',
  readOnly = false,
  disabled = false,
  freeText = false,
  locale: _locale,
  name,
  form,
  label,
  id: idProp,
  required,
  ...rest
}: Props = $props();
const hiddenId = $props.id();
const labelId = `${hiddenId}-label`;
const controlId = $derived(idProp ?? `${hiddenId}-control`);
const labelProps = $derived(
  label ? { id: controlId, 'aria-labelledby': labelId } : { id: idProp },
);
let select: Select | undefined = $state();
let input: Input | undefined = $state();
const choices = $derived(options.filter((option) => option.value !== ''));
const retained = $derived(
  value !== '' && !choices.some((option) => option.value === value),
);
// Only ProvinceSelect uses freeText; its public event types expose both targets.
const inputRest = $derived(rest as Omit<ComponentProps<typeof Input>, 'value'>);
/** Focus the active shared control. */
export function focus(): void {
  (freeText ? input : select)?.focus();
}
/** Return the active native element. */
export function getElement(): HTMLInputElement | HTMLSelectElement | null {
  return (freeText ? input : select)?.getElement() ?? null;
}
</script>
{#if label}<FieldLabel id={labelId} for={controlId} {label} {required} />{/if}
{#if freeText}
  <Input {...inputRest} {...labelProps} {required} bind:this={input} bind:value type="text" {name} {form} {placeholder} disabled={disabled || readOnly} />
{:else}
  <Select {...rest} {...labelProps} {required} bind:this={select} bind:value {name} {form} disabled={disabled || readOnly}>
    <option value="">{placeholder}</option>
    {#if retained}<option value={value}>{value}</option>{/if}
    {#each choices as option}<option value={option.value} disabled={option.disabled}>{option.label ?? option.value}</option>{/each}
  </Select>
{/if}
{#if readOnly}<Input id={hiddenId} type="hidden" {name} {form} {value} {disabled} interaction={false} />{/if}
