<script lang="ts">
/**
 * DictationButton — the microphone next to a text field (see `Dictation`).
 *
 * Tap to start listening, tap again to stop. It is always there, so people
 * who cannot (or do not know to) press and hold the field can still speak.
 * 44px target, named by `aria-label`, `aria-pressed` while listening, and a
 * listening dot that does not rely on color alone (the name changes too).
 * Pair it with `DictationStatus` for the words ("Listening…", errors).
 */
import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';
import Button from '../ui/Button.svelte';
import type { Dictation } from './dictation.svelte.js';
import { primeReadyBeep } from './ready-beep.js';

export interface Props {
  /** The dictation this button starts and stops. */
  dictation: Dictation;
  /** Disable the button (for example while the form sends). */
  disabled?: boolean;
  /** Accessible name to start (default "Speak instead of typing"). */
  label?: string;
  /** Accessible name to stop (default "Stop listening"). */
  stopLabel?: string;
  /** Tooltip (default mentions press-and-hold on the text box). */
  title?: string;
  /** Extra class names. */
  class?: string;
}

let {
  dictation,
  disabled = false,
  label,
  stopLabel,
  title,
  class: className = '',
}: Props = $props();

const { t } = useI18n();
const active = $derived(dictation.active);
const name = $derived(
  active
    ? (stopLabel ?? t(M['ui.dictation.stop']))
    : (label ?? t(M['ui.dictation.start'])),
);

function handleClick() {
  // A tap is a user gesture: wake the audio so the ready beep can play.
  primeReadyBeep();
  void dictation.unlock();
  void dictation.toggle();
}
</script>

<Button
  type="button"
  variant="ghost"
  size="sm"
  class={`smrt-dictation-button${active ? ' smrt-dictation-button--listening' : ''} ${className}`.trim()}
  aria-label={name}
  aria-pressed={active}
  title={active ? name : (title ?? t(M['ui.dictation.start_hint']))}
  {disabled}
  onclick={handleClick}
  data-dictation-state={dictation.state}
>
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3"></rect>
    <path d="M5 10a7 7 0 0 0 14 0"></path>
    <path d="M12 17v4"></path>
  </svg>
  {#if active}
    <span class="smrt-dictation-dot" aria-hidden="true"></span>
  {/if}
</Button>

<style>
  :global(.smrt-dictation-button) {
    position: relative;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 44px;
    block-size: 44px;
    min-inline-size: 44px;
    padding: 0;
    border-radius: var(--smrt-radius-full, 9999px);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  :global(.smrt-dictation-button--listening) {
    background: var(--smrt-color-error-container, #ffdad6);
    color: var(--smrt-color-on-error-container, #410002);
  }

  .smrt-dictation-dot {
    position: absolute;
    inset-block-start: 6px;
    inset-inline-end: 6px;
    inline-size: 10px;
    block-size: 10px;
    border-radius: 50%;
    background: var(--smrt-color-error, #ba1a1a);
    animation: smrt-dictation-pulse 1.2s ease-in-out infinite;
  }

  @keyframes smrt-dictation-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .smrt-dictation-dot {
      animation: none;
    }
  }
</style>
