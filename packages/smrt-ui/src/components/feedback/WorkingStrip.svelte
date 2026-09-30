<script lang="ts">
/**
 * WorkingStrip — "something is working" status.
 *
 * - `variant="strip"`: a thin bar (place it above a phone bottom bar); with
 *   `onopen` the whole strip is a button that reopens the surface doing the
 *   work (e.g. an assistant sheet);
 * - `variant="floating"`: the same content as a pill the host floats over
 *   the page (desktop and tablet), with the goal above the current step;
 * - `variant="inline"`: a compact line at the top of a pane.
 *
 * Phases (see `WorkingStatus`): a spinner while `working`; `paused`;
 * `waiting` (the person is needed, with a prominent Review button); `done`
 * (success colors), `failed` (error colors) and `cancelled`, each with an
 * icon and text, never color alone; nothing while `idle`.
 *
 * Accessibility: two live regions stay mounted. Step changes are announced
 * politely, at most once per `announceIntervalMs`; `waiting` and `failed`
 * are announced assertively. The strip never takes focus by itself. Escape
 * inside it pauses the work when `onpause` is given. Every control is at
 * least 44px (strip and floating).
 */
import { onDestroy, untrack } from 'svelte';
import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';
import {
  WORKING_ASSERTIVE_PHASES,
  type WorkingPhase,
  type WorkingStatus,
} from './working-status.js';

export interface Props {
  /** What is happening. */
  status: WorkingStatus;
  /** `strip` (above a bottom bar), `floating` (a pill), or `inline`. */
  variant?: 'strip' | 'floating' | 'inline';
  /** Show a Stop button while the work runs, is paused, or waits. */
  canStop?: boolean;
  /** Stop the work. */
  onstop?: () => void;
  /** Pause the work (shows Pause while working; Escape pauses too). */
  onpause?: () => void;
  /** Continue paused work (shows Continue while paused). */
  onresume?: () => void;
  /** Open what the work is waiting on (shows Review while waiting). */
  onreview?: () => void;
  /** Reopen the surface doing the work (strip and floating). */
  onopen?: () => void;
  /** Hide a finished status (shows Close once done, failed or cancelled). */
  ondismiss?: () => void;
  /** Accessible hint for `onopen` (default "Open"). */
  openLabel?: string;
  /** Stop button text (default "Stop"). */
  stopLabel?: string;
  /** Pause button text (default "Pause"). */
  pauseLabel?: string;
  /** Continue button text (default "Continue"). */
  resumeLabel?: string;
  /** Review button text (default "Review"). */
  reviewLabel?: string;
  /** Minimum time between two polite step announcements. Default 2000ms. */
  announceIntervalMs?: number;
}

let {
  status,
  variant = 'strip',
  canStop = false,
  onstop,
  onpause,
  onresume,
  onreview,
  onopen,
  ondismiss,
  openLabel,
  stopLabel,
  pauseLabel,
  resumeLabel,
  reviewLabel,
  announceIntervalMs = 2000,
}: Props = $props();

const { t } = useI18n();

const DEFAULT_LABEL = {
  working: M['ui.working_strip.working'],
  paused: M['ui.working_strip.paused'],
  waiting: M['ui.working_strip.waiting'],
  done: M['ui.working_strip.done'],
  failed: M['ui.working_strip.failed'],
  cancelled: M['ui.working_strip.cancelled'],
} satisfies Record<Exclude<WorkingPhase, 'idle'>, unknown>;

const phase = $derived(status.phase);
const visible = $derived(phase !== 'idle');
const label = $derived(
  phase === 'idle' ? '' : (status.label ?? t(DEFAULT_LABEL[phase])),
);
const goal = $derived(status.goal?.trim() || null);
const assertive = $derived(WORKING_ASSERTIVE_PHASES.includes(phase));
const terminal = $derived(
  phase === 'done' || phase === 'failed' || phase === 'cancelled',
);
const running = $derived(
  phase === 'working' || phase === 'paused' || phase === 'waiting',
);
const accessibleSummary = $derived(goal ? `${goal}. ${label}` : label);

// Polite announcements, throttled so a fast run does not chatter.
let politeText = $state('');
let lastAnnouncedAt = 0;
let announceTimer: ReturnType<typeof setTimeout> | null = null;

function announce(text: string) {
  if (announceTimer) clearTimeout(announceTimer);
  announceTimer = null;
  const wait = Math.max(0, lastAnnouncedAt + announceIntervalMs - Date.now());
  if (wait === 0 || text === '') {
    politeText = text;
    lastAnnouncedAt = text ? Date.now() : lastAnnouncedAt;
    return;
  }
  announceTimer = setTimeout(() => {
    announceTimer = null;
    politeText = text;
    lastAnnouncedAt = Date.now();
  }, wait);
}

$effect(() => {
  const text = visible && !assertive ? label : '';
  untrack(() => announce(text));
});

onDestroy(() => {
  if (announceTimer) clearTimeout(announceTimer);
});

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && phase === 'working' && onpause) {
    event.stopPropagation();
    onpause();
  }
}
</script>

<div class="working-strip__live" aria-live="polite" aria-atomic="true">
  {politeText}
</div>
<div class="working-strip__live" aria-live="assertive" aria-atomic="true">
  {visible && assertive ? accessibleSummary : ''}
</div>

{#if visible}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="working-strip working-strip--{variant}"
    data-phase={phase}
    data-testid="working-strip"
    onkeydown={handleKeydown}
  >
    {#snippet content()}
      <span class="working-strip__icon" aria-hidden="true">
        {#if phase === 'working'}
          <span class="working-strip__spinner"></span>
        {:else if phase === 'paused'}
          <span class="working-strip__glyph">&#10074;&#10074;</span>
        {:else if phase === 'waiting'}
          <span class="working-strip__glyph">!</span>
        {:else if phase === 'done'}
          <span class="working-strip__glyph">&#10003;</span>
        {:else if phase === 'failed'}
          <span class="working-strip__glyph">&#10005;</span>
        {:else if phase === 'cancelled'}
          <span class="working-strip__glyph">&#9632;</span>
        {/if}
      </span>
      <span class="working-strip__text" aria-hidden="true">
        {#if goal && variant === 'floating'}
          <span class="working-strip__goal">{goal}</span>
        {/if}
        <span class="working-strip__label">{label}</span>
      </span>
    {/snippet}

    {#if variant !== 'inline' && onopen}
      <button
        type="button"
        class="working-strip__main"
        aria-label={`${accessibleSummary}. ${openLabel ?? t(M['ui.working_strip.open'])}`}
        onclick={onopen}
      >
        {@render content()}
      </button>
    {:else}
      <div class="working-strip__main">
        <span class="working-strip__sr">{accessibleSummary}</span>
        {@render content()}
      </div>
    {/if}

    <div class="working-strip__actions">
      {#if phase === 'waiting' && onreview}
        <button
          type="button"
          class="working-strip__button working-strip__button--primary"
          onclick={onreview}
        >
          {reviewLabel ?? t(M['ui.working_strip.review'])}
        </button>
      {/if}
      {#if phase === 'working' && onpause}
        <button type="button" class="working-strip__button" onclick={onpause}>
          {pauseLabel ?? t(M['ui.working_strip.pause'])}
        </button>
      {/if}
      {#if phase === 'paused' && onresume}
        <button
          type="button"
          class="working-strip__button working-strip__button--primary"
          onclick={onresume}
        >
          {resumeLabel ?? t(M['ui.working_strip.resume'])}
        </button>
      {/if}
      {#if canStop && running}
        <button type="button" class="working-strip__button" onclick={onstop}>
          {stopLabel ?? t(M['ui.working_strip.stop'])}
        </button>
      {/if}
      {#if terminal && ondismiss}
        <button
          type="button"
          class="working-strip__button working-strip__button--icon"
          aria-label={t(M['ui.working_strip.dismiss'])}
          onclick={ondismiss}
        >
          <span aria-hidden="true">&#10005;</span>
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .working-strip__live,
  .working-strip__sr {
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

  .working-strip--floating {
    box-sizing: border-box;
    min-block-size: 3.5rem;
    max-inline-size: min(34rem, calc(100vw - 2rem));
    padding-block: var(--smrt-spacing-1);
    padding-inline-end: var(--smrt-spacing-2);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-xl, 1.25rem);
    box-shadow: var(--smrt-elevation-3);
  }

  .working-strip--inline {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border-block-end: 1px solid var(--smrt-color-outline-variant);
  }

  .working-strip[data-phase='waiting'] {
    background: var(--smrt-color-tertiary-container, var(--smrt-color-primary-container));
    color: var(--smrt-color-on-tertiary-container, var(--smrt-color-on-primary-container));
  }

  .working-strip[data-phase='done'] {
    background: var(--smrt-color-success-container, var(--smrt-color-primary-container));
    color: var(--smrt-color-on-success-container, var(--smrt-color-on-primary-container));
  }

  .working-strip[data-phase='failed'] {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
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
    border-radius: inherit;
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
  .working-strip__button:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: -2px;
  }

  .working-strip__icon {
    display: inline-grid;
    flex: none;
    place-items: center;
    inline-size: 1.25rem;
  }

  .working-strip__glyph {
    font-weight: 700;
    line-height: 1;
  }

  .working-strip__text {
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
  }

  .working-strip__goal {
    overflow: hidden;
    font: var(--smrt-typography-label-medium-font);
    opacity: 0.8;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .working-strip__label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .working-strip__spinner {
    display: block;
    inline-size: 1rem;
    block-size: 1rem;
    border: 2px solid
      color-mix(in srgb, currentColor 25%, transparent);
    border-block-start-color: currentColor;
    border-radius: var(--smrt-radius-full);
    animation: working-strip-spin 0.8s linear infinite;
  }

  .working-strip__actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--smrt-spacing-1);
  }

  .working-strip__button {
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

  .working-strip__button--primary {
    border-color: transparent;
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
  }

  .working-strip__button--icon {
    padding: 0;
  }

  .working-strip--inline .working-strip__button {
    min-block-size: 2rem;
  }

  @keyframes working-strip-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .working-strip__spinner {
      animation: none;
      border-block-start-color: color-mix(in srgb, currentColor 25%, transparent);
      border-inline-start-color: currentColor;
    }
  }
</style>
