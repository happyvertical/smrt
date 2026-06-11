<script module lang="ts">
let tooltipIdCounter = 0;
</script>

<script lang="ts">
/**
 * Tooltip — anchored, delayed text bubble for a trigger.
 *
 * Shows on hover and keyboard focus, hides on leave / blur / Escape. The trigger
 * is wired to the bubble via `aria-describedby` (always set; the bubble is in the
 * DOM and revealed on open), and the bubble carries `role="tooltip"`. CSS-anchored
 * via a `placement` prop — no JS positioning dependency.
 */
import type { Snippet } from 'svelte';
import type { TooltipPlacement } from '../../types-generic';

export interface Props {
  /** Tooltip text. */
  text: string;
  /** Placement relative to the trigger. */
  placement?: TooltipPlacement;
  /** Show delay in ms. */
  delay?: number;
  /** The trigger content. */
  children: Snippet;
}

const { text, placement = 'top', delay = 400, children }: Props = $props();

const tipId = `smrt-tooltip-${(tooltipIdCounter += 1)}`;
let open = $state(false);
let timer: ReturnType<typeof setTimeout> | null = null;

function show() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    open = true;
  }, delay);
}

function hide() {
  if (timer) clearTimeout(timer);
  timer = null;
  open = false;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') hide();
}
</script>

<!-- Presentational wrapper: it only listens for hover/focus/Escape to toggle the
     bubble; the real interactive element is the consumer's trigger child. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="tooltip-wrap"
  onmouseenter={show}
  onmouseleave={hide}
  onfocusin={show}
  onfocusout={hide}
  onkeydown={onKeydown}
>
  <span class="tooltip-trigger" aria-describedby={tipId}>
    {@render children()}
  </span>
  <span id={tipId} role="tooltip" class="tooltip tooltip--{placement}" class:open>
    {text}
  </span>
</span>

<style>
  .tooltip-wrap {
    position: relative;
    display: inline-flex;
  }

  .tooltip {
    position: absolute;
    z-index: var(--smrt-z-index-tooltip, 1080);
    display: none;
    width: max-content;
    max-width: 16rem;
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border-radius: var(--smrt-radius-small, 4px);
    background: var(--smrt-color-inverse-surface, #313033);
    color: var(--smrt-color-inverse-on-surface, #f4eff4);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    line-height: var(--smrt-typography-body-small-line-height, 1.4);
    pointer-events: none;
  }

  .tooltip.open {
    display: block;
  }

  .tooltip--top {
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-bottom: var(--smrt-spacing-1, 4px);
  }
  .tooltip--bottom {
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-top: var(--smrt-spacing-1, 4px);
  }
  .tooltip--left {
    right: 100%;
    top: 50%;
    transform: translateY(-50%);
    margin-right: var(--smrt-spacing-1, 4px);
  }
  .tooltip--right {
    left: 100%;
    top: 50%;
    transform: translateY(-50%);
    margin-left: var(--smrt-spacing-1, 4px);
  }
</style>
