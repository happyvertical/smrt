<script lang="ts">
/**
 * DictationButton — the microphone next to a text field (see `Dictation`).
 *
 * Tap to start listening, tap again to stop. It is always there, so people
 * who cannot (or do not know to) press and hold the field can still speak.
 * 44px target, named by `aria-label`, `aria-pressed` while listening, and a
 * listening dot that does not rely on color alone (the name changes too).
 * Pair it with `DictationStatus` for the words ("Listening…", errors).
 *
 * Hands-free (`mode: 'hands-free'`): a steady ring means it is listening,
 * a halo that swells with the voice means someone is speaking, and a small
 * spinner means sentences are being written down. The ring is the
 * non-motion cue; the halo and spinner stop moving for people who ask for
 * reduced motion. While the page speaks a reply (`Dictation.suspend()`) the
 * button dims with a dashed outline and its tooltip reads "Paused while the
 * assistant speaks". Tapping ends it either way. The help text ("Just talk;
 * I write it down when you pause...") is the tooltip and the button's
 * `aria-describedby`, never a line of text in the form.
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
const handsFree = $derived(dictation.handsFree);
// Paused while the assistant speaks (half-duplex): not hearing, still open.
const paused = $derived(active && handsFree && dictation.suspended);
const speaking = $derived(active && handsFree && dictation.speaking && !paused);
const writing = $derived(handsFree && dictation.queued > 0);
// While a recording is being written down, a tap would do nothing.
const busy = $derived(dictation.state === 'transcribing');
const name = $derived(
  active
    ? (stopLabel ?? t(M['ui.dictation.stop']))
    : (label ?? t(M['ui.dictation.start'])),
);
const uid = $props.id();
const helpId = `smrt-dictation-help-${uid}`;
const hint = $derived(
  active
    ? handsFree
      ? paused
        ? t(M['ui.dictation.paused_speaking'])
        : t(M['ui.dictation.listening_hands_free'])
      : name
    : (title ??
        t(
          dictation.wantsHandsFree
            ? M['ui.dictation.start_hands_free']
            : M['ui.dictation.start_hint'],
        )),
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
  class={`smrt-dictation-button${active ? ' smrt-dictation-button--listening' : ''}${active && handsFree ? ' smrt-dictation-button--hands-free' : ''}${speaking ? ' smrt-dictation-button--speaking' : ''}${paused ? ' smrt-dictation-button--paused' : ''} ${className}`.trim()}
  aria-label={name}
  aria-pressed={active}
  aria-busy={busy || undefined}
  title={hint}
  aria-describedby={hint !== name ? helpId : undefined}
  disabled={disabled || busy}
  onclick={handleClick}
  data-dictation-state={dictation.state}
  data-dictation-mode={handsFree ? 'hands-free' : undefined}
  data-dictation-speaking={speaking || undefined}
  data-dictation-paused={paused || undefined}
  style={speaking ? `--smrt-dictation-level: ${dictation.level}` : undefined}
>
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3"></rect>
    <path d="M5 10a7 7 0 0 0 14 0"></path>
    <path d="M12 17v4"></path>
  </svg>
  {#if active}
    <span class="smrt-dictation-dot" aria-hidden="true"></span>
  {/if}
  {#if writing || (handsFree && dictation.state === 'transcribing')}
    <span class="smrt-dictation-writing" aria-hidden="true"></span>
  {/if}
</Button>
{#if hint !== name}
  <span id={helpId} class="smrt-dictation-help">{hint}</span>
{/if}

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

  /* Read out with the button's name; never shown. */
  .smrt-dictation-help {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
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

  /* Hands-free: a steady ring while listening ... */
  :global(.smrt-dictation-button--hands-free) {
    box-shadow: 0 0 0 2px var(--smrt-color-error, #ba1a1a);
  }

  /* ... and a halo that swells with the voice while someone is speaking. */
  :global(.smrt-dictation-button--speaking) {
    box-shadow:
      0 0 0 3px var(--smrt-color-error, #ba1a1a),
      0 0 0
        calc(4px + 10px * var(--smrt-dictation-level, 0))
        color-mix(in srgb, var(--smrt-color-error, #ba1a1a) 28%, transparent);
    transition: box-shadow 80ms linear;
  }

  /* Paused while the assistant speaks: a dashed, dimmed ring (not color alone). */
  :global(.smrt-dictation-button--paused) {
    opacity: 0.6;
    box-shadow: none;
    outline: 2px dashed var(--smrt-color-outline, #73777f);
    outline-offset: -2px;
  }

  :global(.smrt-dictation-button--paused) .smrt-dictation-dot {
    animation: none;
    opacity: 0.4;
  }

  /* Sentences are being written down. */
  .smrt-dictation-writing {
    position: absolute;
    inset-block-end: 6px;
    inset-inline-end: 6px;
    inline-size: 10px;
    block-size: 10px;
    border-radius: 50%;
    border: 2px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-block-start-color: var(--smrt-color-primary, #2f5ea8);
    background: var(--smrt-color-surface, #fff);
    animation: smrt-dictation-spin 0.9s linear infinite;
  }

  @keyframes smrt-dictation-spin {
    to {
      transform: rotate(360deg);
    }
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
    .smrt-dictation-dot,
    .smrt-dictation-writing {
      animation: none;
    }

    /* Still ringed, but the halo no longer animates with the voice. */
    :global(.smrt-dictation-button--speaking) {
      transition: none;
      box-shadow: 0 0 0 4px var(--smrt-color-error, #ba1a1a);
    }
  }
</style>
