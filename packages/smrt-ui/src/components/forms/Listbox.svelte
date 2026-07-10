<script lang="ts">
import { highlightControl, revealControl } from './control-dom.js';
import type {
  ControlInteractionOptions,
  ControlOption,
} from './control-interaction.js';
import { tryGetControlInteractionContext } from './control-interaction-context.js';
import { useControlRegistration } from './use-control-registration.svelte.js';
export interface Props {
  options: ControlOption[];
  value?: string | number;
  label: string;
  name?: string;
  disabled?: boolean;
  interaction?: ControlInteractionOptions | false;
  onvaluechange?: (value: string | number) => void;
  class?: string;
}
let {
  options,
  value = $bindable(),
  label,
  name,
  disabled = false,
  interaction,
  onvaluechange,
  class: className = '',
}: Props = $props();
const instanceId = $props.id();
const interactionContext = tryGetControlInteractionContext();
let rootEl = $state<HTMLDivElement | null>(null);
let optionEls = $state<Array<HTMLButtonElement | null>>([]);
const controlId = $derived(
  interaction === false
    ? undefined
    : (interaction?.id ?? name ?? `listbox-${instanceId}`),
);
function select(next: unknown) {
  const option = options.find((item) => String(item.value) === String(next));
  if (!option || option.disabled || disabled) return;
  value = option.value;
  onvaluechange?.(option.value);
}
function move(event: KeyboardEvent, index: number) {
  let next = index;
  if (event.key === 'ArrowDown') next = (index + 1) % options.length;
  else if (event.key === 'ArrowUp')
    next = (index - 1 + options.length) % options.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = options.length - 1;
  else return;
  event.preventDefault();
  while (options[next]?.disabled && next !== index)
    next =
      event.key === 'ArrowUp'
        ? (next - 1 + options.length) % options.length
        : (next + 1) % options.length;
  optionEls[next]?.focus();
}
useControlRegistration(() => {
  const root = rootEl;
  if (!root || interaction === false) return false;
  return {
    controlId,
    subject: interaction?.subject,
    metadata: {
      kind: 'listbox',
      label,
      description: interaction?.description,
      sensitivity: interaction?.sensitivity ?? 'public',
      readable: interaction?.readable,
      writable: interaction?.writable,
      options,
    },
    getValue: () => value,
    setValue: select,
    clear: () => {
      value = undefined;
    },
    focus: () => optionEls.find((item) => item && !item.disabled)?.focus(),
    reveal: () => revealControl(root),
    highlight: (durationMs) => highlightControl(root, durationMs),
    getState: () => ({ disabled }),
  };
});
</script>
<div bind:this={rootEl} class="listbox {className}" role="listbox" aria-label={label} aria-disabled={disabled} data-smrt-control={controlId} data-smrt-form={interactionContext?.formId}>
  {#each options as option, index (option.value)}<button bind:this={optionEls[index]} type="button" role="option" aria-selected={value === option.value}
    disabled={disabled || option.disabled} tabindex={value === option.value || (value === undefined && index === 0) ? 0 : -1}
    onkeydown={(event) => move(event, index)} onclick={() => select(option.value)}>{option.label}</button>{/each}
</div>
<style>
  .listbox { display: grid; padding: var(--smrt-spacing-1); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-small); background: var(--smrt-color-surface); }
  button { padding: var(--smrt-spacing-2) var(--smrt-spacing-3); border: 0; border-radius: var(--smrt-radius-extra-small); background: transparent; color: var(--smrt-color-on-surface); text-align: left; cursor: pointer; }
  button[aria-selected='true'] { background: var(--smrt-color-secondary-container); color: var(--smrt-color-on-secondary-container); } button:focus-visible { outline: 2px solid var(--smrt-color-primary); }
  button:disabled { opacity: .5; cursor: not-allowed; } :global(.listbox[data-smrt-highlighted='true']) { outline: 3px solid var(--smrt-color-tertiary); outline-offset: 4px; }
</style>
