<script lang="ts">
import type { HTMLInputAttributes } from 'svelte/elements';
import type { ControlInteractionOptions } from './control-interaction.js';
import Input from './Input.svelte';
export interface Props
  extends Omit<HTMLInputAttributes, 'type' | 'value' | 'class'> {
  /** Selected date value as a string (bindable). */
  value?: string;
  /** Label for the date picker control. */
  label: string;
  /** CSS class to apply to the picker container. */
  class?: string;
  /** Interaction options or false to disable all. */
  interaction?: ControlInteractionOptions | false;
}
let {
  value = $bindable(''),
  label,
  id,
  name,
  class: className = '',
  interaction,
  ...rest
}: Props = $props();
const instanceId = $props.id();
const resolvedId = $derived(id ?? `smrt-date-${instanceId}`);
</script>
<label class="picker {className}" for={resolvedId}><span>{label}</span><Input id={resolvedId} {name} type="date" aria-label={label} {interaction} bind:value {...rest} /></label>
<style>.picker { display: grid; gap: var(--smrt-spacing-1); color: var(--smrt-color-on-surface); font: var(--smrt-typography-label-large-font); }</style>
