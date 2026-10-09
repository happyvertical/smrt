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
  Form,
  Input,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy } from 'svelte';
import { createCaptionChannel } from '../../svelte/components/assistant/captions/caption-state.svelte.js';
import HeardCaptions from '../../svelte/components/assistant/captions/HeardCaptions.svelte';
import { M } from '../../svelte/i18n.js';

const { t } = useI18n();

export interface Props {
  /** Receives a completed spoken or typed turn. */
  onfinal: (text: string) => void | Promise<void>;
  /** Prevents starting speech or submitting text while the host is busy. */
  disabled?: boolean;
}

let { onfinal, disabled = false }: Props = $props();
let typed = $state('');
const messageInputId = $props.id();
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
  if (!final || disabled || sending) return;
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

<section class="character-conversation-voice" aria-label={t(M['chat.character_conversation.voice_input'])}>
  <div class="voice-actions">
    <DictationButton
      {dictation}
      disabled={(sending || disabled) && dictation.state !== 'listening'}
      label={t(M['chat.character_conversation.speak'])}
      stopLabel="Stop listening"
      title={t(M['chat.character_conversation.speak'])}
    />
    <DictationStatus {dictation} />
  </div>

  {#if dictation.state === 'error'}
    <p class="typed-fallback" role="status">
      {t(M['chat.character_conversation.unavailable'])}
    </p>
  {/if}
  {#if deliveryError}
    <p role="alert">{deliveryError}</p>
  {/if}

  <Form class="typed-form" onsubmit={submitTyped}>
    <label for={messageInputId}>
      {t(M['chat.character_conversation.message'])}
      <Input id={messageInputId} class="typed-input" value={typed} oninput={(event) => (typed = event.currentTarget.value)} disabled={disabled || sending} maxlength={4000} />
    </label>
    <Button type="submit" disabled={disabled || sending || !typed.trim()} onclick={submitTyped}>{t(M['chat.character_conversation.send'])}</Button>
  </Form>

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
  .character-conversation-voice :global(.typed-form) { display: flex; inline-size: 100%; flex-wrap: wrap; align-items: end; gap: .5rem; }
  label { display: grid; gap: .25rem; flex: 1 1 16rem; }
  .character-conversation-voice :global(.typed-input) { min-block-size: 2.5rem; padding-inline: .65rem; }
  .typed-fallback { margin: 0; }
</style>
