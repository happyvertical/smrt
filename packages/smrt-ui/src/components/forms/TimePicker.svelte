<script lang="ts">
import type { HTMLInputAttributes } from 'svelte/elements';
import type { ControlInteractionOptions } from './control-interaction.js';
import Input from './Input.svelte';
export interface Props
  extends Omit<HTMLInputAttributes, 'type' | 'value' | 'class'> {
  /** The selected time value in HH:mm format. */
  value?: string;
  /** Label displayed above the time input. */
  label: string;
  /** Additional CSS class names. */
  class?: string;
  /** Registers this control for agent interaction; omit or pass false to exclude. */
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
const resolvedId = $derived(id ?? `smrt-time-${instanceId}`);
</script>
<label class="smrt-time-picker__root {className}" for={resolvedId} data-smrt-component="TimePicker"><span>{label}</span><Input id={resolvedId} {name} type="time" aria-label={label} {interaction} bind:value {...rest} /></label>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-time-picker__root {
    display: grid;
    gap: var(--smrt-spacing-1);
  }
}

@layer smrt.theme {
  .smrt-time-picker__root {
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-label-large-font);
  }
}

</style>
