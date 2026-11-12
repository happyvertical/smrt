<script lang="ts">
import { Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { useAppState } from '../../../hooks/useAppState.svelte.js';
import { M } from '../../../i18n/strings.workspace.js';
import type { GetSTTOptions } from '../../index.js';
import DownloadProgress from './DownloadProgress.svelte';

const { t } = useI18n();

/** Props for STTTest component */
export interface Props {
  /** Optional CSS class */
  class?: string;
}

const { class: className = '' }: Props = $props();

type AdapterType = 'browser-speech' | 'whisper-wasm' | 'whisper-cpp';

const app = useAppState();

let selectedAdapter: AdapterType = $state('whisper-wasm');
let isRecording = $state(false);
let transcript = $state('');
let error = $state<string | null>(null);
let logs = $state<string[]>([]);

// Reactive state from app
const sttState = $derived(app.state.ai.stt);
const isInitializing = $derived(sttState.initState === 'initializing');
const isReady = $derived(sttState.initState === 'ready');
const currentAdapterType = $derived(sttState.adapter?.type ?? 'none');
const downloadProgress = $derived(sttState.downloadProgress);

function log(msg: string) {
  const timestamp = new Date().toLocaleTimeString();
  logs = [...logs, `[${timestamp}] ${msg}`];
}

async function initializeAdapter() {
  error = null;
  log(`Initializing ${selectedAdapter}...`);

  try {
    const options: GetSTTOptions = { type: selectedAdapter };
    await app.initializeSTT(options);
    log(`${selectedAdapter} initialized successfully`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error = msg;
    log(`Error: ${msg}`);
  }
}

async function startRecording() {
  if (isRecording) return;

  error = null;
  transcript = '';
  log('Starting recording...');

  try {
    // Make sure adapter is initialized
    if (!isReady || currentAdapterType !== selectedAdapter) {
      await initializeAdapter();
    }

    isRecording = true;
    await app.startListening({ continuous: true, interimResults: false });
    log('Recording started');
  } catch (err) {
    isRecording = false;
    const msg = err instanceof Error ? err.message : String(err);
    error = msg;
    log(`Error starting: ${msg}`);
  }
}

async function stopRecording() {
  if (!isRecording) return;

  log('Stopping recording...');
  isRecording = false;

  try {
    await app.stopListening();
    log('Recording stopped');

    // Wait a moment for the result
    await new Promise((resolve) => setTimeout(resolve, 200));

    const result = sttState.lastResult || '';
    transcript = result;
    log(`Result: "${result}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error = msg;
    log(`Error stopping: ${msg}`);
  }
}

function clearLogs() {
  logs = [];
}
</script>

<div class="smrt-stt-test__root" data-smrt-component="STTTest">
  <h3 data-smrt-part="title">{t(M['ui.stt_test.heading'])}</h3>

  <div class="smrt-stt-test__controls" data-smrt-part="actions">
    <div class="smrt-stt-test__adapter-select" data-smrt-part="field">
      <label for="adapter" data-smrt-part="label">Adapter:</label>
      <Select
        id="adapter"
        bind:value={
          () => selectedAdapter,
          (v) => {
            selectedAdapter = v as AdapterType;
          }
        }
        disabled={isRecording}
      >
        <option value="browser-speech">{t(M['ui.stt_test.adapter_browser'])}</option>
        <option value="whisper-wasm">{t(M['ui.stt_test.adapter_whisper_wasm'])}</option>
        <option value="whisper-cpp">{t(M['ui.stt_test.adapter_whisper_cpp'])}</option>
      </Select>
    </div>

    <Button
      variant="primary"
      onclick={initializeAdapter}
      disabled={isRecording || isInitializing}
    >
      Initialize
    </Button>
  </div>

  <div class="smrt-stt-test__status" data-smrt-part="status">
    <span class="smrt-stt-test__status-item" data-smrt-part="meta">
      <strong>Status:</strong>
      {#if isInitializing}
        {t(M['ui.stt_test.status_initializing'])}
      {:else if isReady}
        {t(M['ui.stt_test.status_ready'])}
      {:else}
        {t(M['ui.stt_test.status_not_initialized'])}
      {/if}
    </span>
    <span class="smrt-stt-test__status-item" data-smrt-part="meta">
      <strong>Current:</strong> {currentAdapterType}
    </span>
    <span class="smrt-stt-test__status-item" data-smrt-part="meta">
      <strong>Recording:</strong> {isRecording ? 'Yes' : 'No'}
    </span>
  </div>

  {#if isInitializing && downloadProgress}
    <DownloadProgress
      progress={downloadProgress}
      label="Downloading model..."
    />
  {/if}

  <div class="smrt-stt-test__record-controls" data-smrt-part="row">
    <!-- raw-primitive-allow: press-and-hold record control driven by mousedown/up/leave + touchstart/end (push-to-talk), not a click action; Button has no press-and-hold model so this stays a native button -->
    <button
      type="button"
      class="smrt-stt-test__record-btn"
      class:smrt-stt-test__recording={isRecording}
      onmousedown={startRecording}
      onmouseup={stopRecording}
      onmouseleave={stopRecording}
      ontouchstart={startRecording}
      ontouchend={stopRecording}
      disabled={isInitializing}
      data-smrt-part="trigger"
    >
      {isRecording ? 'Recording...' : 'Hold to Record'}
    </button>
  </div>

  {#if error}
    <div class="smrt-stt-test__error" data-smrt-part="error">{error}</div>
  {/if}

  <div class="smrt-stt-test__result" data-smrt-part="body">
    <strong>Transcript:</strong>
    <div class="smrt-stt-test__transcript" data-smrt-part="body">{transcript || '(no result yet)'}</div>
  </div>

  <div class="smrt-stt-test__logs" data-smrt-part="panel">
    <div class="smrt-stt-test__logs-header" data-smrt-part="header">
      <strong>Logs:</strong>
      <Button variant="ghost" size="sm" onclick={clearLogs}>Clear</Button>
    </div>
    <div class="smrt-stt-test__log-list" data-smrt-part="list">
      {#each logs as logEntry}
        <div class="smrt-stt-test__log-entry" data-smrt-part="row">{logEntry}</div>
      {/each}
    </div>
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-stt-test__root {
    padding: var(--smrt-spacing-md);
    max-width: 500px;
  }
  h3 {
    margin: 0 0 var(--smrt-spacing-md);
  }
  .smrt-stt-test__controls {
    display: flex;
    gap: var(--smrt-spacing-sm);
    align-items: flex-end;
    margin-bottom: var(--smrt-spacing-md);
  }
  .smrt-stt-test__adapter-select {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
    flex: 1;
  }
  .smrt-stt-test__status {
    display: flex;
    gap: var(--smrt-spacing-md);
    margin-bottom: var(--smrt-spacing-md);
    padding: var(--smrt-spacing-sm);
  }
  .smrt-stt-test__status-item {
    display: flex;
    gap: var(--smrt-spacing-1);
  }
  .smrt-stt-test__record-controls {
    display: flex;
    justify-content: center;
    margin: var(--smrt-spacing-md) 0;
  }
  .smrt-stt-test__record-btn {
    padding: var(--smrt-spacing-md) var(--smrt-spacing-xl);
    cursor: pointer;
  }
  .smrt-stt-test__record-btn:disabled {
    cursor: not-allowed;
  }
  .smrt-stt-test__error {
    padding: var(--smrt-spacing-md);
    margin-bottom: var(--smrt-spacing-md);
  }
  .smrt-stt-test__result {
    margin-bottom: var(--smrt-spacing-md);
  }
  .smrt-stt-test__transcript {
    margin-top: var(--smrt-spacing-sm);
    padding: var(--smrt-spacing-md);
    min-height: 60px;
  }
  .smrt-stt-test__logs-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--smrt-spacing-sm);
  }
  .smrt-stt-test__log-list {
    padding: var(--smrt-spacing-sm);
    max-height: 150px;
    overflow-y: auto;
  }
  .smrt-stt-test__log-entry {
    padding: var(--smrt-spacing-1) 0;
  }
}

@layer smrt.theme {
  .smrt-stt-test__root {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface-container-low);
  }
  h3 {
    font: var(--smrt-typography-title-large-font, 1.125rem / 1.25 sans-serif);
  }
  .smrt-stt-test__adapter-select label {
    font: var(--smrt-typography-body-medium-font, 500 0.875rem / 1.25 sans-serif);
  }
  .smrt-stt-test__status {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    background: var(--smrt-color-surface, white);
    border-radius: var(--smrt-radius-small);
  }
  .smrt-stt-test__record-btn {
    font: var(--smrt-typography-label-large-font, 500 1rem / 1.25 sans-serif);
    background: var(--smrt-color-tertiary);
    color: var(--smrt-color-on-tertiary);
    border: none;
    border-radius: var(--smrt-radius-medium);
    transition: all var(--smrt-duration-short3, 200ms) var(--smrt-easing-standard, ease);
  }
  .smrt-stt-test__record-btn:hover:not(:disabled) {
    background: var(--smrt-color-tertiary-container);
    opacity: 0.9;
  }
  .smrt-stt-test__record-btn.smrt-stt-test__recording {
    background: var(--smrt-color-error);
    animation: pulse 1s infinite;
  }
  .smrt-stt-test__record-btn:disabled {
    opacity: 0.5;
  }
  @keyframes pulse {
    0%, 100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.02);
    }
  }
  .smrt-stt-test__error {
    background: var(--smrt-color-error-container);
    border: 1px solid var(--smrt-color-error);
    border-radius: var(--smrt-radius-small);
    color: var(--smrt-color-on-error-container);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
  }
  .smrt-stt-test__transcript {
    background: var(--smrt-color-surface, white);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-small);
    font: var(--smrt-typography-body-large-font, 1rem / 1.5 sans-serif);
  }
  .smrt-stt-test__logs {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
  }
  .smrt-stt-test__log-list {
    background: var(--smrt-color-inverse-surface);
    color: var(--smrt-color-inverse-on-surface);
    border-radius: var(--smrt-radius-small);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-stt-test__record-btn {
      transition: none;
    }
    .smrt-stt-test__record-btn.smrt-stt-test__recording {
      animation: none;
    }
  }
}

</style>
