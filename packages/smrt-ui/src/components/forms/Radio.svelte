<script lang="ts">
import type { HTMLInputAttributes } from 'svelte/elements';
import { getRadioGroupContext } from './radio-group-context.js';
export interface Props
  extends Omit<HTMLInputAttributes, 'type' | 'name' | 'checked' | 'value'> {
  value: string;
  label: string;
  disabled?: boolean;
}
let { value, label, disabled = false, id, onchange, ...rest }: Props = $props();
const instanceId = $props.id();
const group = getRadioGroupContext();
const resolvedId = $derived(id ?? `smrt-radio-${instanceId}`);
$effect(() => group.registerOption({ value, label, disabled }));
function handleChange(event: Event & { currentTarget: HTMLInputElement }) {
  if (event.currentTarget.checked) group.setValue(value);
  onchange?.(event);
}
</script>
<label class="radio" class:disabled={disabled || group.disabled}>
  <input id={resolvedId} type="radio" name={group.name} {value} disabled={disabled || group.disabled} required={group.required}
    checked={group.value === value} onchange={handleChange} {...rest} />
  <span class="radio__mark" aria-hidden="true"></span><span>{label}</span>
</label>
<style>
  .radio { display: inline-flex; align-items: center; gap: var(--smrt-spacing-2); cursor: pointer; }
  .radio.disabled { opacity: .5; cursor: not-allowed; }
  input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .radio__mark { width: 1.15rem; height: 1.15rem; border: 2px solid var(--smrt-color-outline); border-radius: 50%; display: grid; place-items: center; }
  .radio__mark::after { content: ''; width: .55rem; height: .55rem; border-radius: 50%; background: var(--smrt-color-primary); transform: scale(0); transition: transform var(--smrt-duration-short2); }
  input:checked + .radio__mark { border-color: var(--smrt-color-primary); }
  input:checked + .radio__mark::after { transform: scale(1); }
  input:focus-visible + .radio__mark { outline: 2px solid var(--smrt-color-primary); outline-offset: 3px; }
</style>
