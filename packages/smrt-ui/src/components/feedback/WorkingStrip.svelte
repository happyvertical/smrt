<script lang="ts">
/**
 * WorkingStrip — "something is working" status.
 *
 * - `variant="strip"`: a thin bar (place it above a phone bottom bar); with
 *   `onopen` the whole strip is a button that reopens the surface doing the
 *   work (e.g. an assistant sheet);
 * - `variant="inline"`: a compact line at the top of a pane.
 *
 * Shows a spinner while `working`, a short confirmation while `done`, and
 * nothing while `idle`. Status changes are announced through a polite live
 * region that stays mounted. A Stop button appears only when `canStop`.
 */
import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';
import type { WorkingStatus } from './working-status.js';

export interface Props {
  /** What is happening. */
  status: WorkingStatus;
  /** `strip` (above a bottom bar) or `inline` (top of a pane). */
  variant?: 'strip' | 'inline';
  /** Show a Stop button while working. */
  canStop?: boolean;
  /** Stop the work. */
  onstop?: () => void;
  /** Reopen the surface doing the work (strip only). */
  onopen?: () => void;
  /** Accessible hint for `onopen` (default "Open"). */
  openLabel?: string;
  /** Stop button text (default "Stop"). */
  stopLabel?: string;
}

let {
  status,
  variant = 'strip',
  canStop = false,
  onstop,
  onopen,
  openLabel,
  stopLabel,
}: Props = $props();

const { t } = useI18n();
const visible = $derived(status.phase !== 'idle');
const label = $derived(
  status.label ??
    (status.phase === 'done'
      ? t(M['ui.working_strip.done'])
      : t(M['ui.working_strip.working'])),
);
</script>

<div class="working-strip__live" aria-live="polite" aria-atomic="true">
  {visible ? label : ''}
</div>

{#if visible}
  <div
    class="working-strip working-strip--{variant}"
    data-phase={status.phase}
    data-testid="working-strip"
  >
    {#if variant === 'strip' && onopen}
      <button
        type="button"
        class="working-strip__main"
        aria-label={`${label}. ${openLabel ?? t(M['ui.working_strip.open'])}`}
        onclick={onopen}
      >
        {#if status.phase === 'working'}
          <span class="working-strip__spinner" aria-hidden="true"></span>
        {/if}
        <span class="working-strip__label" aria-hidden="true">{label}</span>
      </button>
    {:else}
      <div class="working-strip__main">
        {#if status.phase === 'working'}
          <span class="working-strip__spinner" aria-hidden="true"></span>
        {/if}
        <span class="working-strip__label" aria-hidden="true">{label}</span>
      </div>
    {/if}
    {#if canStop && status.phase === 'working'}
      <button type="button" class="working-strip__stop" onclick={onstop}>
        {stopLabel ?? t(M['ui.working_strip.stop'])}
      </button>
    {/if}
  </div>
{/if}

<style>
  .working-strip__live {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .working-strip {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    min-inline-size: 0;
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-body-medium-font);
  }

  .working-strip--strip {
    box-sizing: border-box;
    min-block-size: 2.75rem;
    padding-inline-end: var(--smrt-spacing-2);
    border-block-start: 1px solid var(--smrt-color-outline-variant);
    box-shadow: var(--smrt-elevation-2);
  }

  .working-strip--inline {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border-block-end: 1px solid var(--smrt-color-outline-variant);
  }

  .working-strip[data-phase='done'] {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }

  .working-strip__main {
    display: flex;
    flex: 1;
    align-items: center;
    gap: var(--smrt-spacing-2);
    min-inline-size: 0;
    min-block-size: 2.75rem;
    padding: 0 var(--smrt-spacing-4);
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
  }

  button.working-strip__main {
    cursor: pointer;
  }

  .working-strip--inline .working-strip__main {
    min-block-size: 0;
    padding: 0;
  }

  .working-strip__main:focus-visible,
  .working-strip__stop:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }

  .working-strip__label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .working-strip__spinner {
    flex: none;
    inline-size: 1rem;
    block-size: 1rem;
    border: 2px solid
      color-mix(in srgb, currentColor 25%, transparent);
    border-block-start-color: currentColor;
    border-radius: var(--smrt-radius-full);
    animation: working-strip-spin 0.8s linear infinite;
  }

  .working-strip__stop {
    flex: none;
    min-inline-size: 2.75rem;
    min-block-size: 2.75rem;
    padding: 0 var(--smrt-spacing-4);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-label-large-font);
    cursor: pointer;
  }

  .working-strip--inline .working-strip__stop {
    min-block-size: 2rem;
  }

  @keyframes working-strip-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .working-strip__spinner {
      animation-duration: 2.4s;
    }
  }
</style>
