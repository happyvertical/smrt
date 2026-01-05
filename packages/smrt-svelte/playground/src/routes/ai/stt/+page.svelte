<script lang="ts">
import {
  CapabilityGate,
  STTTest,
  useSTT,
  VoiceInput,
} from '@happyvertical/smrt-svelte';

const stt = useSTT();

let transcriptions = $state<string[]>([]);

function handleTranscription(text: string) {
  if (text.trim()) {
    transcriptions = [...transcriptions, text];
  }
}

function clearTranscriptions() {
  transcriptions = [];
}
</script>

<h1>Speech-to-Text</h1>
<p class="description">
  Try browser-based speech recognition. Click the microphone and speak.
</p>

<section>
  <h2>Adapter Test</h2>
  <STTTest />
</section>

<CapabilityGate require="stt">
  <section>
    <h2>Voice Input</h2>
    <div class="voice-section">
      <VoiceInput
        onTranscription={handleTranscription}
        language="en-US"
        size="lg"
      />

      <div class="status">
        {#if stt.isListening}
          <span class="listening">Listening...</span>
        {:else if stt.isInitializing}
          <span class="initializing">Initializing... {stt.downloadProgress}%</span>
        {:else}
          <span class="ready">Click to start</span>
        {/if}
      </div>
    </div>
  </section>

  <section>
    <div class="transcriptions-header">
      <h2>Transcriptions</h2>
      {#if transcriptions.length > 0}
        <button class="clear-btn" onclick={clearTranscriptions}>Clear</button>
      {/if}
    </div>

    {#if transcriptions.length > 0}
      <ul class="transcriptions">
        {#each transcriptions as text, i}
          <li>{text}</li>
        {/each}
      </ul>
    {:else}
      <p class="empty">No transcriptions yet. Click the mic and speak!</p>
    {/if}
  </section>

  {#snippet fallback()}
    <div class="not-available">
      <p>Speech-to-text is not available in this browser.</p>
      <p>Try Chrome, Edge, or Safari for Web Speech API support.</p>
    </div>
  {/snippet}
</CapabilityGate>

<section>
  <h2>Adapter Info</h2>
  <table class="info-table">
    <tbody>
      <tr>
        <td>Status</td>
        <td>{stt.isReady ? 'Ready' : stt.isInitializing ? 'Initializing' : 'Not initialized'}</td>
      </tr>
      <tr>
        <td>Listening</td>
        <td>{stt.isListening ? 'Yes' : 'No'}</td>
      </tr>
      {#if stt.error}
        <tr>
          <td>Error</td>
          <td class="error">{stt.error.message}</td>
        </tr>
      {/if}
    </tbody>
  </table>
</section>

<style>
  h1 {
    font-size: 1.75rem;
    margin-bottom: 8px;
  }

  .description {
    color: #666;
    margin-bottom: 32px;
  }

  section {
    margin-bottom: 40px;
  }

  h2 {
    font-size: 1rem;
    color: #333;
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid #eee;
  }

  .voice-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    padding: 40px;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
  }

  .status {
    font-size: 0.875rem;
  }

  .status .listening {
    color: #ef4444;
    font-weight: 500;
  }

  .status .initializing {
    color: #f59e0b;
  }

  .status .ready {
    color: #9ca3af;
  }

  .transcriptions-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .transcriptions-header h2 {
    margin-bottom: 0;
    border-bottom: none;
    padding-bottom: 0;
  }

  .clear-btn {
    padding: 4px 12px;
    background: #f3f4f6;
    border: none;
    border-radius: 4px;
    color: #6b7280;
    cursor: pointer;
    font-size: 0.75rem;
  }

  .clear-btn:hover {
    background: #e5e7eb;
  }

  .transcriptions {
    list-style: none;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    overflow: hidden;
  }

  .transcriptions li {
    padding: 12px 16px;
    border-bottom: 1px solid #f3f4f6;
  }

  .transcriptions li:last-child {
    border-bottom: none;
  }

  .empty {
    color: #9ca3af;
    font-style: italic;
  }

  .not-available {
    padding: 40px;
    text-align: center;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 8px;
    color: #991b1b;
  }

  .info-table {
    width: 100%;
    border-collapse: collapse;
  }

  .info-table td {
    padding: 8px 12px;
    border-bottom: 1px solid #f3f4f6;
  }

  .info-table td:first-child {
    font-weight: 500;
    color: #6b7280;
    width: 120px;
  }

  .info-table .error {
    color: #ef4444;
  }
</style>
