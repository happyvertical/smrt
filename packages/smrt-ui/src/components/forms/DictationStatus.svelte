<script lang="ts">
/**
 * DictationStatus — what dictation is doing, in words (see `Dictation`).
 *
 * "Listening…" (with the words heard so far) while the microphone is on, and
 * a plain explanation when it cannot listen: the browser cannot turn speech
 * into text, the microphone is blocked, or nothing was heard. Nothing while
 * idle. Listening is announced politely; problems are announced as alerts.
 */
import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';
import type { Dictation, DictationErrorKind } from './dictation.svelte.js';

export interface Props {
  dictation: Dictation;
  /** Extra class names. */
  class?: string;
}

let { dictation, class: className = '' }: Props = $props();

const { t } = useI18n();
const showLine = $derived(
  dictation.state === 'starting' ||
    dictation.state === 'listening' ||
    dictation.state === 'stopping',
);

function errorText(kind: DictationErrorKind | null): string {
  switch (kind) {
    case 'unsupported':
      return t(M['ui.dictation.unsupported']);
    case 'denied':
      return t(M['ui.dictation.denied']);
    case 'no-speech':
      return t(M['ui.dictation.no_speech']);
    case 'microphone':
      return t(M['ui.dictation.microphone']);
    case 'interrupted':
      return t(M['ui.dictation.interrupted']);
    default:
      return t(M['ui.dictation.failed']);
  }
}
</script>

<div class={`smrt-dictation-status ${className}`.trim()}>
  <p
    class="smrt-dictation-status-line"
    class:smrt-dictation-status--empty={!showLine}
    role="status"
    aria-live="polite"
  >
    {#if dictation.state === 'starting'}
      {t(M['ui.dictation.starting'])}
    {:else if dictation.state === 'listening' || dictation.state === 'stopping'}
      <span class="smrt-dictation-status-dot" aria-hidden="true"></span>
      {t(M['ui.dictation.listening'])}
      {#if dictation.interim}
        <span class="smrt-dictation-status-interim">“{dictation.interim}”</span>
      {/if}
    {/if}
  </p>
  <p
    class="smrt-dictation-status-error"
    class:smrt-dictation-status--empty={dictation.state !== 'error'}
    role="alert"
    data-dictation-error={dictation.state === 'error'
      ? (dictation.errorCode ?? dictation.errorKind)
      : undefined}
  >
    {#if dictation.state === 'error'}
      {errorText(dictation.errorKind)}
    {/if}
  </p>
</div>

<style>
  .smrt-dictation-status {
    display: contents;
  }

  .smrt-dictation-status-line,
  .smrt-dictation-status-error {
    margin: 0;
    font: var(--smrt-typography-body-small-font, 0.8125rem / 1.4 sans-serif);
  }


  .smrt-dictation-status-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0;
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  /* Kept mounted while empty (live regions must exist before they speak),
     but take no room. */
  .smrt-dictation-status--empty {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    padding: 0;
    white-space: nowrap;
  }

  .smrt-dictation-status-dot {
    inline-size: 8px;
    block-size: 8px;
    border-radius: 50%;
    background: var(--smrt-color-error, #ba1a1a);
  }

  .smrt-dictation-status-interim {
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-style: italic;
  }

  .smrt-dictation-status-error {
    padding: 0.4rem 0.6rem;
    border-radius: var(--smrt-radius-medium, 8px);
    background: var(--smrt-color-error-container, #ffdad6);
    color: var(--smrt-color-on-error-container, #410002);
  }
</style>
