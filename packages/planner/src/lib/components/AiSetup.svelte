<script lang="ts">
import { Button, Icon } from '@happyvertical/smrt-ui';
import {
  FieldLabel,
  Input,
  Select,
  Switch,
} from '@happyvertical/smrt-ui/forms';
import { HEAR_ICON, SPEAK_ICON, THINK_ICON } from '../ai/icons.ts';
import { aiState } from '../ai/instance.ts';
import type { CapabilityId } from '../ai/status.ts';
import {
  ASSISTANT_MODELS,
  formatSize,
  getModel,
  graphicsBufferLimit,
  hasRoomFor,
  ROOMY_MODEL_ID,
  shortLabel,
} from '../assistant/models.ts';
import {
  SPEECH_MODELS,
  type SpeechModelId,
  speechModelChoice,
} from '../assistant/voice.svelte.ts';

interface AiSetupProps {
  /** Which cards to show; all three by default. */
  show?: CapabilityId[];
}

let { show = ['think', 'hear', 'speak'] }: AiSetupProps = $props();

const session = $derived(aiState.session);
const voice = $derived(aiState.voice);
const summaries = $derived(aiState.capabilities);
const capabilityState = (id: CapabilityId) =>
  summaries.find((s) => s.id === id)?.state ?? 'available';

const mode = $derived(aiState.inference.mode);
const byo = $derived(aiState.byo);
const thinkWhere = $derived(
  summaries.find((s) => s.id === 'think')?.where ?? '',
);

const model = $derived(getModel(session.prefs.modelId));
// A roomy graphics card can run the smarter model; it is only suggested, the
// visitor's own choice is never changed for them.
let bufferLimit = $state(0);
$effect(() => {
  void graphicsBufferLimit().then((limit) => {
    bufferLimit = limit;
  });
});
const roomy = $derived(getModel(ROOMY_MODEL_ID));
const suggestRoomy = $derived(
  !!roomy &&
    session.prefs.modelId !== ROOMY_MODEL_ID &&
    session.status !== 'loading' &&
    session.status !== 'ready' &&
    hasRoomFor(roomy, bufferLimit),
);
const thinkPercent = $derived(Math.round(session.progress.progress * 100));
const hearPercent = $derived(Math.round(voice.progress * 100));
const hearMegabytes = $derived(Math.round(voice.size / 1_000_000));
const speechChoice = $derived(speechModelChoice(voice.model));
// Hands-free needs the downloaded model; say so instead of a dead switch.
const handsFreeAvailable = $derived(voice.status === 'ready');
</script>

{#if aiState.notice}
  <p class="notice" role="status">{aiState.notice}</p>
{/if}

<div class="cards">
  {#if show.includes('think')}
    <section class="card" data-state={capabilityState('think')} aria-labelledby="ai-think">
      <header>
        <span class="badge"><Icon path={THINK_ICON} size={22} /></span>
        <div>
          <h2 id="ai-think">Think</h2>
          <p class="sub">
            The assistant's language model{thinkWhere ? `: ${thinkWhere}` : ''}
          </p>
        </div>
      </header>
      {#if mode === 'host'}
        <p class="status">Server</p>
        <p class="meta">
          This site's server answers the assistant. What you type, and a short
          summary of your plan, is sent to it. Nothing is downloaded.
        </p>
      {:else if mode === 'byo' && byo}
        {@const preset = byo.preset}
        <label>
          Model provider
          <Select
            value={byo.presetId}
            onchange={(event) => byo.select(event.currentTarget.value)}
          >
            {#each byo.presets as option (option.id)}
              <option value={option.id}>{option.label}</option>
            {/each}
          </Select>
        </label>
        <div class="field">
          <FieldLabel for="byo-url" label="Address" />
          <Input
            id="byo-url"
            type="url"
            autocomplete="off"
            spellcheck={false}
            placeholder="https://example.com/v1"
            value={byo.baseUrl}
            readonly={!preset?.customUrl}
            oninput={(event) => byo.setBaseUrl(event.currentTarget.value)}
          />
        </div>
        <div class="field">
          <FieldLabel for="byo-model" label="Model" />
          <Input
            id="byo-model"
            type="text"
            autocomplete="off"
            spellcheck={false}
            value={byo.model}
            oninput={(event) => byo.setModel(event.currentTarget.value)}
          />
        </div>
        {#if !preset?.keyless}
          <div class="field">
            <FieldLabel for="byo-key" label="Key" />
            <Input
              id="byo-key"
              type="password"
              autocomplete="off"
              spellcheck={false}
              placeholder="Paste your key"
              value={byo.key}
              oninput={(event) => byo.setKey(event.currentTarget.value)}
            />
          </div>
          {#if byo.keyForOtherAddress}
            <p class="meta">
              A key is saved for another address, so it is not used here. Paste it again for this address.
            </p>
          {/if}
          <p class="meta">
            Stored only in this browser, and sent only to {byo.baseUrl || 'the address above'} (https, or this computer).
            <button class="link" type="button" onclick={() => byo.forgetKey()}>
              Forget the key
            </button>
          </p>
        {/if}
        {#if preset?.cors}
          <p class="meta"><strong>Browser access.</strong> {preset.cors}</p>
        {/if}
        <p class="meta">
          What you type, and a short summary of your plan, is sent to this
          endpoint.
        </p>
        {#if byo.testStatus === 'ok' || byo.testStatus === 'failed' || byo.testStatus === 'testing'}
          <p
            class={byo.testStatus === 'failed' ? 'error' : 'status'}
            role={byo.testStatus === 'failed' ? 'alert' : 'status'}
          >
            {byo.testStatus === 'testing' ? 'Testing…' : byo.testMessage}
          </p>
        {/if}
        {#if byo.active}
          <p class="status" role="status">Using {byo.model}.</p>
        {/if}
        <div class="actions">
          <Button
            variant="secondary"
            disabled={byo.testStatus === 'testing'}
            onclick={() => void byo.test()}
          >
            Test connection
          </Button>
          {#if byo.active}
            <Button variant="secondary" onclick={() => byo.stop()}>Stop using</Button>
          {:else}
            <Button disabled={!byo.complete} onclick={() => byo.use()}>Use this model</Button>
          {/if}
        </div>
      {:else if session.status === 'unsupported'}
        <p role="status">
          This browser has no WebGPU, which the model needs. Try a recent
          Chrome, Edge or Safari on a computer. The Planner works without it.
        </p>
      {:else}
        <label>
          Model
          <Select
            value={session.prefs.modelId}
            disabled={session.status === 'loading'}
            onchange={(event) => session.select(event.currentTarget.value)}
          >
            {#each ASSISTANT_MODELS as option (option.id)}
              <option value={option.id}>{option.label}</option>
            {/each}
          </Select>
        </label>
        {#if model}
          <p class="meta">
            {formatSize(model.downloadMB)} to download once; needs
            {formatSize(model.vramMB)} of graphics memory. Use Wi-Fi on a
            metered connection.
          </p>
        {/if}
        {#if suggestRoomy && roomy}
          <p class="meta">
            Your graphics card has room for {shortLabel(roomy)}, which
            understands more.
            <Button variant="secondary" onclick={() => session.select(ROOMY_MODEL_ID)}>
              Use {shortLabel(roomy)}
            </Button>
          </p>
        {/if}
        {#if session.status === 'ready'}
          <p class="status" role="status">
            {model ? shortLabel(model) : 'The model'} is ready.
          </p>
          <div class="actions">
            <Button variant="secondary" onclick={() => session.unload()}>Unload</Button>
          </div>
        {:else if session.status === 'loading'}
          <div role="status" aria-live="polite">
            <progress max="100" value={thinkPercent} aria-label="Model download progress"
              >{thinkPercent}%</progress
            >
            <p class="meta">{thinkPercent}%. {session.progress.text}</p>
          </div>
          <div class="actions">
            <Button variant="secondary" onclick={() => session.cancel()}>Cancel</Button>
          </div>
        {:else}
          <p class="status">
            {session.consented ? 'Downloaded. Load it to start.' : 'Not downloaded.'}
          </p>
          {#if session.status === 'error'}
            <p class="error" role="alert">
              The model could not start: {session.error}
            </p>
          {/if}
          <div class="actions">
            <Button onclick={() => void session.start()}>
              {session.consented ? 'Load' : 'Download'}
            </Button>
          </div>
        {/if}
      {/if}
    </section>
  {/if}

  {#if show.includes('hear')}
    <section class="card" data-state={capabilityState('hear')} aria-labelledby="ai-hear">
      <header>
        <span class="badge"><Icon path={HEAR_ICON} size={22} /></span>
        <div>
          <h2 id="ai-hear">Hear</h2>
          <p class="sub">Voice typing, speech to text</p>
        </div>
      </header>
      {#if voice.status === 'checking'}
        <p class="meta" role="status">Checking this browser.</p>
      {:else if voice.status === 'browser'}
        <p class="status">Built into your browser.</p>
      {:else if voice.status === 'downloading'}
        <div role="status" aria-live="polite">
          {#if voice.preparing}
            <p class="meta">Getting ready…</p>
          {:else}
            <progress max="100" value={hearPercent} aria-label="Speech model download"
              >{hearPercent}%</progress
            >
            <p class="meta">
              {voice.cached ? 'Turning on' : 'Downloading'} {hearPercent}%
            </p>
          {/if}
        </div>
        <div class="actions">
          <Button variant="secondary" onclick={() => voice.cancel()}>Cancel</Button>
        </div>
      {:else if voice.status === 'ready'}
        <p class="status">
          {speechChoice.label}, running on this device.
        </p>
      {:else}
        <p class="meta">
          {voice.browserWorks
            ? 'You chose the downloadable model.'
            : "Your browser can't do voice typing on its own."}
          {formatSize(hearMegabytes)}, downloaded once.
          {voice.cached ? 'It is already on this device.' : ''}
        </p>
        {#if voice.status === 'error'}
          <p class="error" role="alert">
            Voice typing could not start: {voice.error}
          </p>
        {/if}
        <div class="actions">
          <Button onclick={() => void voice.enable()}>
            {voice.cached ? 'Turn on' : 'Download'}
          </Button>
        </div>
      {/if}
      {#if voice.status !== 'browser' && voice.status !== 'checking'}
        <label>
          Speech model
          <Select
            value={voice.model}
            disabled={voice.status === 'downloading'}
            onchange={(event) =>
              void voice.setModel(event.currentTarget.value as SpeechModelId)}
          >
            {#each SPEECH_MODELS as option (option.id)}
              <option value={option.id}>
                {option.label}, {formatSize(Math.round(option.bytes / 1_000_000))}
              </option>
            {/each}
          </Select>
        </label>
        <p class="meta">{speechChoice.note}.</p>
      {/if}
      {#if voice.browserWorks && voice.status !== 'downloading'}
        <Switch
          checked={voice.preferLocal}
          label="Use the downloadable model instead"
          onchange={(event) => void voice.setPreferLocal(event.currentTarget.checked)}
        />
      {/if}
      {#if voice.status !== 'checking'}
        <Switch
          checked={aiState.prefs.handsFree}
          disabled={!handsFreeAvailable && !aiState.prefs.handsFree}
          label="Hands-free"
          onchange={(event) => aiState.setHandsFree(event.currentTarget.checked)}
        />
        <p class="meta">
          Start when I talk, stop when I pause.
          {handsFreeAvailable ? '' : 'Needs the downloaded speech model.'}
        </p>
        <Switch
          checked={aiState.prefs.sendOnPause}
          disabled={!aiState.handsFreeActive}
          label="Send when I stop talking"
          onchange={(event) => aiState.setSendOnPause(event.currentTarget.checked)}
        />
        <p class="meta">
          Sends your message after a short pause. Needs Hands-free.
        </p>
      {/if}
    </section>
  {/if}

  {#if show.includes('speak')}
    <section class="card" data-state={capabilityState('speak')} aria-labelledby="ai-speak">
      <header>
        <span class="badge"><Icon path={SPEAK_ICON} size={22} /></span>
        <div>
          <h2 id="ai-speak">Speak</h2>
          <p class="sub">Read replies aloud, text to speech</p>
        </div>
      </header>
      {#if aiState.speakSupported}
        <p class="status">Browser voices</p>
        <Switch
          checked={aiState.prefs.readAloud}
          label="Read replies aloud"
          onchange={(event) => aiState.setReadAloud(event.currentTarget.checked)}
        />
        <p class="meta">A better voice you can download is coming.</p>
      {:else}
        <p role="status">This browser has no speech synthesis.</p>
      {/if}
    </section>
  {/if}
</div>

<style>
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--smrt-spacing-4);
    min-width: 0;
  }

  .card {
    display: grid;
    align-content: start;
    gap: var(--smrt-spacing-3);
    padding: var(--smrt-spacing-4);
    min-width: 0;
    overflow-wrap: anywhere;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-lg, 12px);
    background: var(--smrt-color-surface-container-low, transparent);
  }

  header {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3);
  }

  .badge {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 50%;
    border: 1px solid var(--smrt-color-outline-variant);
  }

  .card[data-state='ready'] .badge {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
    border-color: transparent;
  }

  .card[data-state='available'] .badge {
    border: 1px dashed var(--smrt-color-outline);
    color: var(--smrt-color-on-surface-variant);
  }

  .card[data-state='off'] .badge {
    position: relative;
    border: 1px dashed var(--smrt-color-outline-variant);
    opacity: 0.5;
  }

  .card[data-state='off'] .badge::after {
    content: '';
    position: absolute;
    width: 70%;
    height: 0;
    border-top: 2px solid currentColor;
    transform: rotate(-45deg);
  }

  h2,
  p {
    margin: 0;
  }

  .sub,
  .meta,
  label {
    color: var(--smrt-color-on-surface-variant);
  }

  .status {
    font-weight: 600;
  }

  label {
    display: grid;
    gap: var(--smrt-spacing-1);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
  }

  progress {
    width: 100%;
  }

  .error {
    color: var(--smrt-color-error);
  }

  .notice {
    margin: 0 0 var(--smrt-spacing-3);
    padding: var(--smrt-spacing-3);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
  }

  .field {
    display: grid;
    gap: var(--smrt-spacing-1);
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--smrt-color-primary);
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
</style>
