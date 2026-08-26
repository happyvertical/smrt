<script lang="ts">
/**
 * Form — the Provider-free base `<form>` primitive.
 *
 * A thin, dependency-free wrapper around the native `<form>` element so domain
 * components have a primitive to adopt instead of hand-rolling raw `<form>`
 * markup (issue #1589). It forwards every native form attribute (including
 * `onsubmit`) and renders its children — no Provider, no i18n, no spoken-input
 * logic.
 *
 * For the rich, Provider-backed form with field registration and voice input,
 * use `Form` from `@happyvertical/smrt-svelte/forms` instead. This one is the
 * leaf-level building block; that one composes app state on top.
 *
 * `preventDefault` (default `true`) calls `event.preventDefault()` before
 * invoking the consumer's `onsubmit`, so a click/Enter submit runs the handler
 * without a full-page navigation — the near-universal SPA pattern. Pass
 * `preventDefault={false}` to keep native submission (e.g. a GET/POST `action`).
 */
import type { Snippet } from 'svelte';
import type { HTMLFormAttributes } from 'svelte/elements';
import {
  type ControlInteractionEvent,
  type ControlInteractionRegistry,
  createControlInteractionRegistry,
} from './control-interaction.js';
import { setControlInteractionContext } from './control-interaction-context.js';
import StagedControlReview from './StagedControlReview.svelte';

export interface Props extends Omit<HTMLFormAttributes, 'class'> {
  class?: string;
  preventDefault?: boolean;
  /** Stable form scope used by voice/chat/tutorial adapters. */
  formId?: string;
  /** Supply a registry to coordinate multiple forms or inspect commands. */
  interactionRegistry?: ControlInteractionRegistry;
  /** Receives registry lifecycle and command events. */
  oninteraction?: (event: ControlInteractionEvent) => void;
  /** Render the built-in human review surface for staged changes. */
  stagedReview?: boolean;
  children: Snippet;
}

let {
  class: className = '',
  preventDefault = true,
  formId,
  interactionRegistry,
  oninteraction,
  stagedReview = true,
  id,
  name,
  onsubmit,
  children,
  ...rest
}: Props = $props();

const instanceId = $props.id();
const generatedFormId = `smrt-form-${instanceId}`;
const localInteractionRegistry = createControlInteractionRegistry();
const resolvedFormId = $derived(formId ?? id ?? name ?? generatedFormId);
const resolvedInteractionRegistry = $derived(
  interactionRegistry ?? localInteractionRegistry,
);
let formElement = $state<HTMLFormElement | null>(null);

setControlInteractionContext({
  get formId() {
    return resolvedFormId;
  },
  get registry() {
    return resolvedInteractionRegistry;
  },
});

$effect(() => {
  if (!oninteraction) return;
  return resolvedInteractionRegistry.subscribe(oninteraction);
});

export function getInteractionRegistry(): ControlInteractionRegistry {
  return resolvedInteractionRegistry;
}

export function getFormId(): string {
  return resolvedFormId;
}

function handleSubmit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
  if (preventDefault) event.preventDefault();
  onsubmit?.(event);
}
</script>

<form
  bind:this={formElement}
  id={id}
  name={name}
  class="form {className}"
  data-smrt-form={resolvedFormId}
  onsubmit={handleSubmit}
  {...rest}
>
	{@render children()}
  <StagedControlReview
    registry={resolvedInteractionRegistry}
    formId={resolvedFormId}
    {formElement}
    summary={stagedReview}
  />
</form>

<!--
  No base styles: a <form> is `display: block` by default, so an explicit
  `.form { display: block }` rule would only add a specificity floor that ties
  with a consumer's single-class layout override (e.g. `:global(.x){display:flex}`)
  and can win by stylesheet order. The `form` class stays as a stable hook.
-->
