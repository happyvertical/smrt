<script lang="ts">
import type { TTSVoice } from '@happyvertical/browser-ai';
import { CapabilityGate, useTTS } from '@happyvertical/smrt-svelte';

const tts = useTTS();

let text = $state(
  'Hello! This is the text-to-speech demo. Try speaking some text!',
);
let selectedVoice = $state<string>('');
let rate = $state(1);
let pitch = $state(1);
let voices = $state<TTSVoice[]>([]);

async function handleSpeak() {
  if (tts.isSpeaking) {
    tts.stop();
  } else {
    await tts.speak(text, {
      voice: selectedVoice || undefined,
      rate,
      pitch,
    });
  }
}

function handlePauseResume() {
  if (tts.isPaused) {
    tts.resume();
  } else {
    tts.pause();
  }
}

async function loadVoices() {
  await tts.initialize();
  voices = tts.getVoices();
}
</script>

<h1>Text-to-Speech</h1>
<p class="description">
  Try browser-based speech synthesis. Type some text and click Speak.
</p>

<CapabilityGate require="tts">
  <section>
    <h2>Text Input</h2>
    <div class="input-section">
      <textarea
        bind:value={text}
        placeholder="Enter text to speak..."
        rows="4"
      ></textarea>

      <div class="controls">
        <button
          class="speak-btn"
          class:speaking={tts.isSpeaking}
          onclick={handleSpeak}
        >
          {tts.isSpeaking ? 'Stop' : 'Speak'}
        </button>

        {#if tts.isSpeaking}
          <button class="pause-btn" onclick={handlePauseResume}>
            {tts.isPaused ? 'Resume' : 'Pause'}
          </button>
        {/if}
      </div>
    </div>
  </section>

  <section>
    <h2>Voice Settings</h2>
    <div class="settings">
      <div class="setting">
        <label for="voice">Voice</label>
        {#if voices.length === 0}
          <button class="load-voices-btn" onclick={loadVoices}>
            Load Voices
          </button>
        {:else}
          <select id="voice" bind:value={selectedVoice}>
            <option value="">Default</option>
            {#each voices as voice}
              <option value={voice.id}>
                {voice.name} ({voice.language})
              </option>
            {/each}
          </select>
        {/if}
      </div>

      <div class="setting">
        <label for="rate">Speed: {rate.toFixed(1)}x</label>
        <input
          id="rate"
          type="range"
          bind:value={rate}
          min="0.5"
          max="2"
          step="0.1"
        />
      </div>

      <div class="setting">
        <label for="pitch">Pitch: {pitch.toFixed(1)}</label>
        <input
          id="pitch"
          type="range"
          bind:value={pitch}
          min="0.5"
          max="2"
          step="0.1"
        />
      </div>
    </div>
  </section>

  {#snippet fallback()}
    <div class="not-available">
      <p>Text-to-speech is not available in this browser.</p>
      <p>Try Chrome, Edge, Firefox, or Safari for Speech Synthesis support.</p>
    </div>
  {/snippet}
</CapabilityGate>

<section>
  <h2>Adapter Info</h2>
  <table class="info-table">
    <tbody>
      <tr>
        <td>Status</td>
        <td>{tts.isReady ? 'Ready' : tts.isInitializing ? 'Initializing' : 'Not initialized'}</td>
      </tr>
      <tr>
        <td>Speaking</td>
        <td>{tts.isSpeaking ? 'Yes' : 'No'}</td>
      </tr>
      <tr>
        <td>Paused</td>
        <td>{tts.isPaused ? 'Yes' : 'No'}</td>
      </tr>
      <tr>
        <td>Voices Loaded</td>
        <td>{voices.length}</td>
      </tr>
      {#if tts.error}
        <tr>
          <td>Error</td>
          <td class="error">{tts.error.message}</td>
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

  .input-section {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 24px;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
  }

  textarea {
    width: 100%;
    padding: 12px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    font-family: inherit;
    font-size: 1rem;
    resize: vertical;
    min-height: 100px;
  }

  textarea:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  .controls {
    display: flex;
    gap: 12px;
    justify-content: center;
  }

  .speak-btn {
    padding: 12px 32px;
    background: #3b82f6;
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .speak-btn:hover {
    background: #2563eb;
  }

  .speak-btn.speaking {
    background: #ef4444;
  }

  .speak-btn.speaking:hover {
    background: #dc2626;
  }

  .pause-btn {
    padding: 12px 24px;
    background: #f3f4f6;
    color: #374151;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .pause-btn:hover {
    background: #e5e7eb;
  }

  .settings {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 24px;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
  }

  .setting {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .setting label {
    font-size: 0.875rem;
    font-weight: 500;
    color: #374151;
  }

  .setting select {
    padding: 8px 12px;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    font-size: 0.875rem;
  }

  .setting input[type="range"] {
    width: 100%;
    accent-color: #3b82f6;
  }

  .load-voices-btn {
    padding: 8px 16px;
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    font-size: 0.875rem;
    cursor: pointer;
    align-self: flex-start;
  }

  .load-voices-btn:hover {
    background: #e5e7eb;
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
