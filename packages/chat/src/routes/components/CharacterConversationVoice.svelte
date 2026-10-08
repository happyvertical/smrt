<script lang="ts">
/**
 * Opt-in microphone input for the local character conversation host.
 *
 * Dictation owns the only recognition subscription. The browser STT adapter
 * is imported and constructed only from the microphone button's user-gesture
 * path; typed input remains available if speech recognition is unavailable.
 */
import {
  Dictation,
  DictationButton,
  type DictationSourceProvider,
  DictationStatus,
} from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy } from 'svelte';
import { createCaptionChannel } from '../../svelte/components/assistant/captions/caption-state.svelte.js';
import HeardCaptions from '../../svelte/components/assistant/captions/HeardCaptions.svelte';

export interface Props {
  /** Receives a completed spoken or typed turn. */
  onfinal: (text: string) => void | Promise<void>;
  /** Prevents starting speech or submitting text while the host is busy. */
  disabled?: boolean;
}

let { onfinal, disabled = false }: Props = $props();
let typed = $state('');
let sending = $state(false);
let deliveryError = $state<string | null>(null);
const heard = createCaptionChannel('heard', { ttlMs: 12_000 });
let sourceProvider: DictationSourceProvider | null = null;

async function source() {
  // This function is called by Dictation only after the microphone button is
  // clicked. createSttDictationSource itself memoizes the one recognizer.
  if (!sourceProvider) {
    const { createSttDictationSource } = await import(
      '@happyvertical/smrt-svelte/browser-ai'
    );
    sourceProvider = createSttDictationSource();
  }
  return sourceProvider();
}

async function deliver(text: string) {
  const final = text.trim();
  if (!final) return;
  deliveryError = null;
  sending = true;
  try {
    await onfinal(final);
  } catch {
    deliveryError = 'Your message could not be sent. Try typing it again.';
  } finally {
    sending = false;
  }
}

const dictation = new Dictation({
  source,
  requestMicrophone: false,
  beep: false,
  onInterim: (text) => heard.setInterim(text),
  onText: (text) => {
    heard.addFinal(text);
    void deliver(text);
  },
});

function submitTyped() {
  const final = typed.trim();
  if (!final || disabled || sending) return;
  void deliver(final).then(() => {
    if (!deliveryError) typed = '';
  });
}

onDestroy(() => {
  dictation.dispose();
  heard.dispose();
});
</script>

<section class="character-conversation-voice" aria-label="Voice input">
  <div class="voice-actions">
    <DictationButton
      {dictation}
      disabled={disabled || sending}
      label="Speak to your assistant"
      stopLabel="Stop listening"
      title="Speak to your assistant"
    />
    <DictationStatus {dictation} />
  </div>

  {#if dictation.state === 'error'}
    <p class="typed-fallback" role="status">
      Speech input is unavailable. Type your message below.
    </p>
  {/if}
  {#if deliveryError}
    <p role="alert">{deliveryError}</p>
  {/if}

  <form onsubmit={(event) => { event.preventDefault(); submitTyped(); }}>
    <label>
      Type your message
      <input bind:value={typed} disabled={disabled || sending} maxlength="4000" />
    </label>
    <Button type="submit" disabled={disabled || sending || !typed.trim()}>Send message</Button>
  </form>

  <HeardCaptions
    enabled={true}
    lines={heard.lines}
    interim={heard.interim}
    placement="inline"
  />
</section>

<style>
  .character-conversation-voice { display: grid; gap: .5rem; }
  .voice-actions { display: flex; align-items: center; gap: .5rem; }
  form { display: flex; flex-wrap: wrap; align-items: end; gap: .5rem; }
  label { display: grid; gap: .25rem; flex: 1 1 16rem; }
  input { min-block-size: 2.5rem; padding-inline: .65rem; }
  .typed-fallback { margin: 0; }
</style>
