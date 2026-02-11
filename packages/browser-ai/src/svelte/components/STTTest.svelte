<script lang="ts">
import type { GetSTTOptions } from '@happyvertical/browser-ai';
import { useAppState } from '@happyvertical/smrt-svelte';
import DownloadProgress from './DownloadProgress.svelte';

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
  console.log(`[STTTest] ${msg}`);
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
  <h3>STT Adapter Test</h3>

  <div class="controls">
    <div class="adapter-select">
      <label for="adapter">Adapter:</label>
      <select id="adapter" bind:value={selectedAdapter} disabled={isRecording}>
        <option value="browser-speech">Browser (Web Speech API)</option>
        <option value="whisper-wasm">Whisper WASM (v2)</option>
        <option value="whisper-cpp">Whisper CPP</option>
      </select>
    </div>

    <button
      type="button"
      onclick={initializeAdapter}
      disabled={isRecording || isInitializing}
    >
      Initialize
    </button>
  </div>

  <div class="status">
    <span class="status-item">
      <strong>Status:</strong>
      {#if isInitializing}
        Initializing...
      {:else if isReady}
        Ready
      {:else}
        Not initialized
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
      <button type="button" onclick={clearLogs}>Clear</button>
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
    padding: 16px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    background: #f9fafb;
    max-width: 500px;
  }

  h3 {
    margin: 0 0 16px;
    font-size: 1.125rem;
  }

  .controls {
    display: flex;
    gap: 12px;
    align-items: flex-end;
    margin-bottom: 16px;
  }

  .adapter-select {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
  }

  .adapter-select label {
    font-size: 0.875rem;
    font-weight: 500;
  }

  .adapter-select select {
    padding: 8px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 0.875rem;
  }

  .controls button {
    padding: 8px 16px;
    background: #3b82f6;
    color: white;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .controls button:hover:not(:disabled) {
    background: #2563eb;
  }

  .controls button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .status {
    display: flex;
    gap: 16px;
    font-size: 0.875rem;
    margin-bottom: 16px;
    padding: 8px;
    background: white;
    border-radius: 4px;
  }

  .status-item {
    display: flex;
    gap: 4px;
  }

  .record-controls {
    display: flex;
    justify-content: center;
    margin: 20px 0;
  }

  .record-btn {
    padding: 16px 32px;
    font-size: 1rem;
    font-weight: 500;
    background: #10b981;
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .record-btn:hover:not(:disabled) {
    background: #059669;
  }

  .record-btn.recording {
    background: #ef4444;
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
    padding: 12px;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 6px;
    color: #991b1b;
    font-size: 0.875rem;
    margin-bottom: 16px;
  }

  .result {
    margin-bottom: 16px;
  }

  .transcript {
    margin-top: 8px;
    padding: 12px;
    background: white;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    min-height: 60px;
    font-size: 1rem;
  }

  .logs {
    font-size: 0.75rem;
  }

  .logs-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .logs-header button {
    padding: 4px 8px;
    font-size: 0.75rem;
    background: #e5e7eb;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .log-list {
    background: #1f2937;
    color: #d1d5db;
    padding: 8px;
    border-radius: 4px;
    max-height: 150px;
    overflow-y: auto;
    font-family: monospace;
  }

  .log-entry {
    padding: 2px 0;
  }
</style>
