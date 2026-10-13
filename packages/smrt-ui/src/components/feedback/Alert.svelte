<script lang="ts">
import type { Snippet } from 'svelte';

export interface Props {
  /** Alert type that controls styling and ARIA role. */
  variant?: 'info' | 'success' | 'warning' | 'error';
  /** Optional heading text displayed above the message. */
  title?: string;
  /** Main message content shown in the alert body. */
  children?: Snippet;
  /** Optional snippet to render an action button or link. */
  action?: Snippet;
  /** Whether a close button appears to dismiss the alert. */
  dismissible?: boolean;
  /** Callback when the user clicks the dismiss button. */
  ondismiss?: () => void;
  /** CSS class to apply to the alert container. */
  class?: string;
}

let {
  variant = 'info',
  title,
  children,
  action,
  dismissible = false,
  ondismiss,
  class: className = '',
}: Props = $props();
const role = $derived(
  variant === 'error' || variant === 'warning' ? 'alert' : 'status',
);
</script>

<div class="smrt-alert__root smrt-alert__{variant} {className}" {role} data-smrt-component="Alert">
  <span class="smrt-alert__marker" data-smrt-part="marker" aria-hidden="true"></span>
  <div class="smrt-alert__content" data-smrt-part="body">
    {#if title}<strong data-smrt-part="title">{title}</strong>{/if}
    {#if children}<div class="smrt-alert__message" data-smrt-part="message">{@render children()}</div>{/if}
  </div>
  {#if action}<div class="smrt-alert__action" data-smrt-part="actions">{@render action()}</div>{/if}
  {#if dismissible}
    <button type="button" class="smrt-alert__dismiss" data-smrt-part="close" aria-label="Dismiss" onclick={ondismiss}>×</button>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-alert__root {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: start;
    gap: var(--smrt-spacing-3);
    padding: var(--smrt-spacing-3) var(--smrt-spacing-4);
  }
  .smrt-alert__marker {
    width: .65rem;
    height: .65rem;
    margin-top: .4rem;
  }
  .smrt-alert__content {
    min-width: 0;
  }
  strong {
    display: block;
  }
  .smrt-alert__action {
    align-self: center;
  }
  .smrt-alert__dismiss {
    width: 2rem;
    height: 2rem;
    margin: -.35rem;
    cursor: pointer;
  }
}
@layer smrt.theme {
  .smrt-alert__root {
    --smrt-alert-color: var(--smrt-color-primary);
    border: var(--smrt-hairline);
    border-color: color-mix(in srgb, var(--smrt-alert-color) 35%, var(--smrt-hairline-color));
    box-shadow: var(--smrt-inset-highlight);
    border-radius: var(--smrt-radius-medium);
    background: color-mix(in srgb, var(--smrt-alert-color) 8%, var(--smrt-surface-panel));
    color: var(--smrt-color-on-surface);
  }
  .smrt-alert__info {
    --smrt-alert-color: var(--smrt-color-info);
  }
  .smrt-alert__success {
    --smrt-alert-color: var(--smrt-color-success);
  }
  .smrt-alert__warning {
    --smrt-alert-color: var(--smrt-color-warning);
  }
  .smrt-alert__error {
    --smrt-alert-color: var(--smrt-color-error);
  }
  .smrt-alert__marker {
    border-radius: 50%;
    background: var(--smrt-alert-color);
  }
  strong {
    font: var(--smrt-typography-title-small-font);
  }
  .smrt-alert__message {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-alert__dismiss {
    border: 0;
    border-radius: var(--smrt-radius-full);
    background: transparent;
    color: inherit;
    font-size: 1.25rem;
  }
  .smrt-alert__dismiss:hover {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent);
  }
  .smrt-alert__dismiss:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
}
</style>
