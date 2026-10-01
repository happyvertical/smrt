<script lang="ts">
import type { HTMLInputAttributes } from 'svelte/elements';
import { getRadioGroupContext } from './radio-group-context.js';
export interface Props
  extends Omit<HTMLInputAttributes, 'type' | 'name' | 'checked' | 'value'> {
  /** Value for this radio button option. */
  value: string;
  /** Text label displayed next to the radio button. */
  label: string;
  /** Whether the radio button is disabled. */
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
<label class="radio" class:disabled={disabled || group.disabled} data-smrt-hit-target>
  <input id={resolvedId} type="radio" name={group.name} {value} disabled={disabled || group.disabled} required={group.required}
    checked={group.value === value} onchange={handleChange} {...rest} />
  <span class="radio__mark" aria-hidden="true"></span><span class="radio__label">{label}</span>
</label>
<style>
  /* The visible mark stays 18px; a transparent 44x44 ::before hit area (see Checkbox) makes the
     touch target. Mark and label text sit above every hit area, so neighbours' hit areas never
     steal their clicks. Beside other content (a group's other options, text, a link) it keeps to
     the mark's column and grows vertically only. --smrt-control-hit-size resizes it (0px turns it
     off). */
  .radio { --_box: 1.15rem; --_hit: max(var(--smrt-control-hit-size, 2.75rem), var(--_box)); position: relative; display: inline-flex; align-items: center; gap: var(--smrt-spacing-2); cursor: pointer; }
  .radio::before { content: ''; position: absolute; z-index: 0; inset-block-start: 50%; inset-inline-start: calc(var(--_box) / 2); inline-size: var(--_hit); block-size: var(--_hit); margin-block-start: calc(var(--_hit) / -2); margin-inline-start: calc(var(--_hit) / -2); }
  .radio:not(:only-child)::before { inline-size: var(--_box); margin-inline-start: calc(var(--_box) / -2); }
  .radio.disabled { opacity: .5; cursor: not-allowed; }
  input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .radio__mark { position: relative; z-index: 1; width: 1.15rem; height: 1.15rem; border: 2px solid var(--smrt-color-outline); border-radius: 50%; display: grid; place-items: center; }
  .radio__label { position: relative; z-index: 1; }
  .radio__mark::after { content: ''; width: .55rem; height: .55rem; border-radius: 50%; background: var(--smrt-color-primary); transform: scale(0); transition: transform var(--smrt-duration-short2); }
  input:checked + .radio__mark { border-color: var(--smrt-color-primary); }
  input:checked + .radio__mark::after { transform: scale(1); }
  input:focus-visible + .radio__mark { outline: 2px solid var(--smrt-color-primary); outline-offset: 3px; }

  /* Table cells: grow vertically only, never into a neighbouring cell. */
  :global(:is(td, th)) .radio::before { inline-size: var(--_box); margin-inline-start: calc(var(--_box) / -2); }
</style>
