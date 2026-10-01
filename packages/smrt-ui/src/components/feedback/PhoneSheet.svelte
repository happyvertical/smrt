<script lang="ts">
/**
 * PhoneSheet — the phone replacement for drawers and centered modals.
 *
 * - `variant="page"`: a full-screen page (a notifications list, a picker);
 * - `variant="sheet"`: slides up from the bottom with a grabber; a swipe down
 *   on its header closes it.
 *
 * It closes on its close button and Escape, moves focus into itself when it
 * opens, and returns focus to the opener when it closes. It is positioned
 * `absolute; inset: 0`, so it covers its nearest positioned ancestor — inside
 * an `AdminShell`, render it in the `overlays` snippet so it covers the
 * screen above the phone bottom bar. The host may keep it mounted while
 * closed (it is hidden and inert), so a chat inside keeps its draft.
 */
import type { Snippet } from 'svelte';
import { tick } from 'svelte';
import { swipeDismiss } from '../../actions/swipe-dismiss.js';
import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';

export interface Props {
  /** Whether the sheet is shown. */
  open: boolean;
  /** Heading shown in the sheet header; also names the dialog. */
  title: string;
  /** Called on the close button, Escape, or a swipe down (sheet). */
  onclose: () => void;
  /** `page` covers the area; `sheet` slides up with rounded corners. */
  variant?: 'page' | 'sheet';
  /** Element id, for `aria-controls` on the button that opens it. */
  id?: string;
  /** Accessible name of the close button (default "Close {title}"). */
  closeLabel?: string;
  /** Sheet body. */
  children: Snippet;
}

let {
  open,
  title,
  onclose,
  variant = 'page',
  id,
  closeLabel,
  children,
}: Props = $props();

const { t } = useI18n();
const instanceId = $props.id();
const headingId = `phone-sheet-${instanceId}`;
let root: HTMLElement | undefined = $state();
let returnFocus: HTMLElement | null = null;

$effect(() => {
  if (!open) return;
  returnFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  void tick().then(() => root?.focus({ preventScroll: true }));
  return () => {
    const target = returnFocus;
    returnFocus = null;
    if (target && document.contains(target)) {
      target.focus({ preventScroll: true });
    }
  };
});

function onkeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  event.preventDefault();
  event.stopPropagation();
  onclose();
}
</script>

<div
  bind:this={root}
  {id}
  class="phone-sheet phone-sheet--{variant}"
  class:open
  role="dialog"
  aria-modal="false"
  aria-labelledby={headingId}
  aria-hidden={!open}
  inert={!open}
  tabindex="-1"
  data-escape-scope
  data-testid="phone-sheet"
  {onkeydown}
>
  <header
    class="phone-sheet__header"
    use:swipeDismiss={{
      direction: 'down',
      onDismiss: onclose,
      enabled: variant === 'sheet',
    }}
  >
    {#if variant === 'sheet'}
      <span class="phone-sheet__grabber" aria-hidden="true"></span>
    {/if}
    <h2 id={headingId}>{title}</h2>
    <button
      type="button"
      class="phone-sheet__close"
      aria-label={closeLabel ?? t(M['ui.phone_sheet.close'], { title })}
      onclick={onclose}
    >
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      >
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  </header>
  <div class="phone-sheet__body">
    {@render children()}
  </div>
</div>

<style>
  .phone-sheet {
    position: absolute;
    inset: 0;
    z-index: 30;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    transform: translateY(100%);
    visibility: hidden;
    transition:
      transform var(--smrt-duration-medium1, 250ms) var(--smrt-easing-standard, ease),
      visibility 0s linear var(--smrt-duration-medium1, 250ms);
    outline: none;
  }

  .phone-sheet.open {
    transform: none;
    visibility: visible;
    transition: transform var(--smrt-duration-medium1, 250ms)
      var(--smrt-easing-standard, ease);
  }

  .phone-sheet--sheet {
    border-start-start-radius: var(--smrt-radius-lg);
    border-start-end-radius: var(--smrt-radius-lg);
    box-shadow: var(--smrt-elevation-3);
  }

  .phone-sheet__header {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2);
    min-block-size: 3.5rem;
    padding-block: 0;
    padding-inline: var(--smrt-spacing-4) var(--smrt-spacing-2);
    border-block-end: 1px solid var(--smrt-color-outline-variant);
    touch-action: pan-x;
  }

  .phone-sheet__grabber {
    position: absolute;
    inset-block-start: var(--smrt-spacing-1);
    inset-inline-start: 50%;
    inline-size: 2.5rem;
    block-size: 0.25rem;
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-outline-variant);
    transform: translateX(-50%);
  }

  .phone-sheet__header h2 {
    margin: 0;
    font: var(--smrt-typography-title-medium-font);
  }

  .phone-sheet__close {
    display: inline-grid;
    place-items: center;
    inline-size: 2.75rem;
    block-size: 2.75rem;
    border: 0;
    border-radius: var(--smrt-radius-full);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .phone-sheet__close:hover,
  .phone-sheet__close:focus-visible {
    background: var(--smrt-color-surface-container-high);
  }

  .phone-sheet__close:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }

  .phone-sheet__body {
    min-block-size: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }

  @media (prefers-reduced-motion: reduce) {
    .phone-sheet,
    .phone-sheet.open {
      transition: none;
    }
  }
</style>
