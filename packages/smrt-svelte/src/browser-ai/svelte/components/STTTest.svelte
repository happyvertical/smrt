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

<div class="stt-test" data-smrt-component="STTTest">
  <h3>{t(M['ui.stt_test.heading'])}</h3>

  <div class="controls">
    <div class="adapter-select">
      <label for="adapter">Adapter:</label>
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

  <div class="status">
    <span class="status-item">
      <strong>Status:</strong>
      {#if isInitializing}
        {t(M['ui.stt_test.status_initializing'])}
      {:else if isReady}
        {t(M['ui.stt_test.status_ready'])}
      {:else}
        {t(M['ui.stt_test.status_not_initialized'])}
      {/if}
    </span>
    <span class="status-item">
      <strong>Current:</strong> {currentAdapterType}
    </span>
    <span class="status-item">
      <strong>Recording:</strong> {isRecording ? 'Yes' : 'No'}
    </span>
  </div>

  {#if isInitializing && downloadProgress}
    <DownloadProgress
      progress={downloadProgress}
      label="Downloading model..."
    />
  {/if}

  <div class="record-controls">
    <!-- raw-primitive-allow: press-and-hold record control driven by mousedown/up/leave + touchstart/end (push-to-talk), not a click action; Button has no press-and-hold model so this stays a native button -->
    <button
      type="button"
      class="record-btn"
      class:recording={isRecording}
      onmousedown={startRecording}
      onmouseup={stopRecording}
      onmouseleave={stopRecording}
      ontouchstart={startRecording}
      ontouchend={stopRecording}
      disabled={isInitializing}
    >
      {isRecording ? 'Recording...' : 'Hold to Record'}
    </button>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="result">
    <strong>Transcript:</strong>
    <div class="transcript">{transcript || '(no result yet)'}</div>
  </div>

  <div class="logs">
    <div class="logs-header">
      <strong>Logs:</strong>
      <Button variant="ghost" size="sm" onclick={clearLogs}>Clear</Button>
    </div>
    <div class="log-list">
      {#each logs as logEntry}
        <div class="log-entry">{logEntry}</div>
      {/each}
    </div>
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .stt-test {
    padding: var(--smrt-spacing-md);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface-container-low);
    max-width: 500px;
  }

  h3 {
    margin: 0 0 var(--smrt-spacing-md);
    font: var(--smrt-typography-title-large-font, 1.125rem / 1.25 sans-serif);
  }

  .controls {
    display: flex;
    gap: var(--smrt-spacing-sm);
    align-items: flex-end;
    margin-bottom: var(--smrt-spacing-md);
  }

  .adapter-select {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
    flex: 1;
  }

  .adapter-select label {
    font: var(--smrt-typography-body-medium-font, 500 0.875rem / 1.25 sans-serif);
  }

  .status {
    display: flex;
    gap: var(--smrt-spacing-md);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    margin-bottom: var(--smrt-spacing-md);
    padding: var(--smrt-spacing-sm);
    background: var(--smrt-color-surface, white);
    border-radius: var(--smrt-radius-small);
  }

  .status-item {
    display: flex;
    gap: var(--smrt-spacing-1);
  }

  .record-controls {
    display: flex;
    justify-content: center;
    margin: var(--smrt-spacing-md) 0;
  }

  .record-btn {
    padding: var(--smrt-spacing-md) var(--smrt-spacing-xl);
    font: var(--smrt-typography-label-large-font, 500 1rem / 1.25 sans-serif);
    background: var(--smrt-color-tertiary);
    color: var(--smrt-color-on-tertiary);
    border: none;
    border-radius: var(--smrt-radius-medium);
    cursor: pointer;
    transition: all var(--smrt-duration-short3, 200ms) var(--smrt-easing-standard, ease);
  }

  .record-btn:hover:not(:disabled) {
    background: var(--smrt-color-tertiary-container);
    opacity: 0.9;
  }

  .record-btn.recording {
    background: var(--smrt-color-error);
    animation: pulse 1s infinite;
  }

  .record-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @keyframes pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.02); }
  }

  .error {
    padding: var(--smrt-spacing-md);
    background: var(--smrt-color-error-container);
    border: 1px solid var(--smrt-color-error);
    border-radius: var(--smrt-radius-small);
    color: var(--smrt-color-on-error-container);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    margin-bottom: var(--smrt-spacing-md);
  }

  .result {
    margin-bottom: var(--smrt-spacing-md);
  }

  .transcript {
    margin-top: var(--smrt-spacing-sm);
    padding: var(--smrt-spacing-md);
    background: var(--smrt-color-surface, white);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-small);
    min-height: 60px;
    font: var(--smrt-typography-body-large-font, 1rem / 1.5 sans-serif);
  }

  .logs {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
  }

  .logs-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--smrt-spacing-sm);
  }

  .log-list {
    background: var(--smrt-color-inverse-surface);
    color: var(--smrt-color-inverse-on-surface);
    padding: var(--smrt-spacing-sm);
    border-radius: var(--smrt-radius-small);
    max-height: 150px;
    overflow-y: auto;
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }

  .log-entry {
    padding: var(--smrt-spacing-1) 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .record-btn {
      transition: none;
    }
    
    .record-btn.recording {
      animation: none;
    }
  }
}
</style>
