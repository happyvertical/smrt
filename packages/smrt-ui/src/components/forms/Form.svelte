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

export interface Props extends Omit<HTMLFormAttributes, 'class'> {
  class?: string;
  preventDefault?: boolean;
  children: Snippet;
}

let {
  class: className = '',
  preventDefault = true,
  onsubmit,
  children,
  ...rest
}: Props = $props();

function handleSubmit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
  if (preventDefault) event.preventDefault();
  onsubmit?.(event);
}
</script>

<form class="form {className}" onsubmit={handleSubmit} {...rest}>
	{@render children()}
</form>

<!--
  No base styles: a <form> is `display: block` by default, so an explicit
  `.form { display: block }` rule would only add a specificity floor that ties
  with a consumer's single-class layout override (e.g. `:global(.x){display:flex}`)
  and can win by stylesheet order. The `form` class stays as a stable hook.
-->

