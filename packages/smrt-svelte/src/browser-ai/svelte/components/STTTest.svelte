<script lang="ts">
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

<div class="stt-test">
  <h3>{t(M['ui.stt_test.heading'])}</h3>

  <div class="controls">
    <div class="adapter-select">
      <label for="adapter">Adapter:</label>
      <select id="adapter" bind:value={selectedAdapter} disabled={isRecording}>
        <option value="browser-speech">{t(M['ui.stt_test.adapter_browser'])}</option>
        <option value="whisper-wasm">{t(M['ui.stt_test.adapter_whisper_wasm'])}</option>
        <option value="whisper-cpp">{t(M['ui.stt_test.adapter_whisper_cpp'])}</option>
      </select>
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
  .stt-test {
    padding: var(--smrt-spacing-md, 16px);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-medium, 8px);
    background: var(--smrt-color-surface-container-low, #f9fafb);
    max-width: 500px;
  }

  h3 {
    margin: 0 0 var(--smrt-spacing-md, 16px);
    font: var(--smrt-typography-title-large-font, 1.125rem / 1.25 sans-serif);
  }

  .controls {
    display: flex;
    gap: var(--smrt-spacing-sm, 12px);
    align-items: flex-end;
    margin-bottom: var(--smrt-spacing-md, 16px);
  }

  .adapter-select {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
    flex: 1;
  }

  .adapter-select label {
    font: var(--smrt-typography-body-medium-font, 500 0.875rem / 1.25 sans-serif);
  }

  .adapter-select select {
    padding: var(--smrt-spacing-sm, 8px);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-small, 6px);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
  }

  .status {
    display: flex;
    gap: var(--smrt-spacing-md, 16px);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    margin-bottom: var(--smrt-spacing-md, 16px);
    padding: var(--smrt-spacing-sm, 8px);
    background: var(--smrt-color-surface, white);
    border-radius: var(--smrt-radius-small, 4px);
  }

  .status-item {
    display: flex;
    gap: var(--smrt-spacing-1, 4px);
  }

  .record-controls {
    display: flex;
    justify-content: center;
    margin: var(--smrt-spacing-md, 20px) 0;
  }

  .record-btn {
    padding: var(--smrt-spacing-md, 16px) var(--smrt-spacing-xl, 32px);
    font: var(--smrt-typography-label-large-font, 500 1rem / 1.25 sans-serif);
    background: var(--smrt-color-tertiary, #006c4f);
    color: var(--smrt-color-on-tertiary, #ffffff);
    border: none;
    border-radius: var(--smrt-radius-medium, 8px);
    cursor: pointer;
    transition: all var(--smrt-duration-short3, 200ms) var(--smrt-easing-standard, ease);
  }

  .record-btn:hover:not(:disabled) {
    background: var(--smrt-color-tertiary-container, #006c4f);
    opacity: 0.9;
  }

  .record-btn.recording {
    background: var(--smrt-color-error, #ba1a1a);
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
    padding: var(--smrt-spacing-md, 12px);
    background: var(--smrt-color-error-container, #ffdad6);
    border: 1px solid var(--smrt-color-error, #ba1a1a);
    border-radius: var(--smrt-radius-small, 6px);
    color: var(--smrt-color-on-error-container, #410002);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    margin-bottom: var(--smrt-spacing-md, 16px);
  }

  .result {
    margin-bottom: var(--smrt-spacing-md, 16px);
  }

  .transcript {
    margin-top: var(--smrt-spacing-sm, 8px);
    padding: var(--smrt-spacing-md, 12px);
    background: var(--smrt-color-surface, white);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-small, 6px);
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
    margin-bottom: var(--smrt-spacing-sm, 8px);
  }

  .log-list {
    background: var(--smrt-color-inverse-surface, #1f2937);
    color: var(--smrt-color-inverse-on-surface, #d1d5db);
    padding: var(--smrt-spacing-sm, 8px);
    border-radius: var(--smrt-radius-small, 4px);
    max-height: 150px;
    overflow-y: auto;
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }

  .log-entry {
    padding: var(--smrt-spacing-1, 4px) 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .record-btn {
      transition: none;
    }
    
    .record-btn.recording {
      animation: none;
    }
  }
</style>
