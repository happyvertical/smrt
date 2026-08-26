<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes } from 'svelte/elements';
import {
  emitControlChange,
  highlightControl,
  revealControl,
} from './control-dom.js';
import type { ControlInteractionOptions } from './control-interaction.js';
import { tryGetControlInteractionContext } from './control-interaction-context.js';
import { useControlRegistration } from './use-control-registration.svelte.js';

export interface Props extends Omit<HTMLButtonAttributes, 'class'> {
  pressed?: boolean;
  class?: string;
  interaction?: ControlInteractionOptions | false;
  children?: Snippet;
}
let {
  pressed = $bindable(false),
  id,
  name,
  disabled = false,
  class: className = '',
  interaction,
  children,
  onclick,
  'aria-label': ariaLabel,
  ...rest
}: Props = $props();
const instanceId = $props.id();
const interactionContext = tryGetControlInteractionContext();
let buttonEl = $state<HTMLButtonElement | null>(null);
const resolvedId = $derived(id ?? `smrt-toggle-button-${instanceId}`);
const controlId = $derived(
  interaction === false ? undefined : (interaction?.id ?? name ?? resolvedId),
);
function setPressed(next: unknown) {
  pressed = Boolean(next);
  if (buttonEl) emitControlChange(buttonEl);
}
function handleClick(event: MouseEvent & { currentTarget: HTMLButtonElement }) {
  pressed = !pressed;
  onclick?.(event);
}
useControlRegistration(() => {
  const element = buttonEl;
  if (!element || interaction === false) return false;
  return {
    controlId,
    subject: interaction?.subject,
    metadata: {
      kind: 'toggle-button',
      label: ariaLabel ?? (element.textContent?.trim() || undefined),
      description: interaction?.description,
      sensitivity: interaction?.sensitivity ?? 'public',
      readable: interaction?.readable,
      writable: interaction?.writable,
    },
    getValue: () => pressed,
    setValue: setPressed,
    clear: () => (setPressed(false), true),
    focus: () => element.focus(),
    reveal: () => revealControl(element),
    highlight: (durationMs) => highlightControl(element, durationMs),
    getState: () => ({ disabled: element.disabled }),
  };
});
</script>
<button bind:this={buttonEl} id={resolvedId} type="button" {name} {disabled} class="toggle-button {className}" class:pressed
  aria-pressed={pressed} aria-label={ariaLabel} data-smrt-control={controlId} data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={interaction === false ? undefined : interaction?.subject?.type}
  data-smrt-subject-id={interaction === false ? undefined : interaction?.subject?.id}
  onclick={handleClick} {...rest}>{@render children?.()}</button>
<style>
  .toggle-button { display: inline-flex; align-items: center; justify-content: center; min-height: 2.5rem; padding: 0 var(--smrt-spacing-4); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-full); background: var(--smrt-color-surface); color: var(--smrt-color-on-surface); cursor: pointer; }
  .toggle-button.pressed { background: var(--smrt-color-secondary-container); color: var(--smrt-color-on-secondary-container); border-color: var(--smrt-color-secondary); }
  .toggle-button:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .toggle-button:disabled { opacity: .5; cursor: not-allowed; }
  .toggle-button[data-smrt-highlighted='true'] { outline: 3px solid var(--smrt-color-tertiary); outline-offset: 4px; }
</style>
