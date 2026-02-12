<script lang="ts">
import { useAppState } from '@happyvertical/smrt-svelte';

const app = useAppState();

const caps = $derived(app.state.capabilities);
</script>

<h1>AI Features</h1>
<p class="description">Browser-based AI capabilities with adapter pattern.</p>

<section>
  <h2>Current Mode</h2>
  <div class="mode-display">
    <span class="mode-badge" class:smrt={app.state.mode === 'smrt'}>
      {app.state.mode.toUpperCase()}
    </span>
    <span class="mode-source">({app.state.modeSource})</span>
  </div>
</section>

<section>
  <h2>Browser Capabilities</h2>
  {#if caps}
    <div class="caps-grid">
      <div class="cap-card">
        <h3>Speech-to-Text</h3>
        <ul>
          <li class:available={caps.stt.browserSpeechAPI}>
            Browser Speech API
          </li>
          <li class:available={caps.stt.whisperWasm}>
            Whisper WASM
          </li>
        </ul>
      </div>

      <div class="cap-card">
        <h3>Text-to-Speech</h3>
        <ul>
          <li class:available={caps.tts.browserSynthesisAPI}>
            Browser Synthesis API
          </li>
          <li class:available={caps.tts.transformersTTS}>
            Transformers.js TTS
          </li>
        </ul>
      </div>

      <div class="cap-card">
        <h3>LLM</h3>
        <ul>
          <li class:available={caps.llm.webllm}>
            WebLLM
          </li>
          <li class:available={caps.llm.webgpu}>
            WebGPU Acceleration
          </li>
        </ul>
      </div>

      <div class="cap-card">
        <h3>Browser Features</h3>
        <ul>
          <li class:available={caps.browser.wasmSupport}>
            WebAssembly
          </li>
          <li class:available={caps.browser.wasmSimd}>
            WASM SIMD
          </li>
          <li class:available={caps.browser.webWorkers}>
            Web Workers
          </li>
          <li class:available={caps.browser.indexedDB}>
            IndexedDB
          </li>
        </ul>
      </div>
    </div>
  {:else}
    <p>Detecting capabilities...</p>
  {/if}
</section>

<section>
  <h2>Demo Pages</h2>
  <div class="demo-links">
    <a href="/ai/stt" class="demo-link">
      <span class="icon">🎤</span>
      <span class="label">Speech-to-Text</span>
      <span class="desc">Try browser speech recognition</span>
    </a>
    <a href="/ai/tts" class="demo-link">
      <span class="icon">🔊</span>
      <span class="label">Text-to-Speech</span>
      <span class="desc">Listen to synthesized speech</span>
    </a>
    <a href="/ai/llm" class="demo-link">
      <span class="icon">🤖</span>
      <span class="label">LLM Chat</span>
      <span class="desc">Chat with local AI model</span>
    </a>
    <a href="/ai/pipeline" class="demo-link">
      <span class="icon">🔗</span>
      <span class="label">Voice → LLM</span>
      <span class="desc">Speak and get AI response</span>
    </a>
  </div>
</section>

<style>
  h1 {
    font-size: 1.75rem;
    margin-bottom: 8px;
  }

  .description {
    color: var(--smrt-color-on-surface-variant);
    margin-bottom: 32px;
  }

  section {
    margin-bottom: 40px;
  }

  h2 {
    font-size: 1rem;
    color: var(--smrt-color-on-surface);
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .mode-display {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .mode-badge {
    padding: 8px 16px;
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
    border-radius: 8px;
    font-weight: 600;
  }

  .mode-badge.smrt {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
  }

  .mode-source {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.875rem;
  }

  .caps-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
  }

  .cap-card {
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    padding: 16px;
  }

  .cap-card h3 {
    font-size: 0.875rem;
    font-weight: 600;
    margin-bottom: 12px;
    color: var(--smrt-color-on-surface);
  }

  .cap-card ul {
    list-style: none;
  }

  .cap-card li {
    padding: 4px 0;
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface-variant);
  }

  .cap-card li::before {
    content: '✗';
    margin-right: 8px;
    color: var(--smrt-color-error);
  }

  .cap-card li.available {
    color: var(--smrt-color-on-surface);
  }

  .cap-card li.available::before {
    content: '✓';
    color: var(--smrt-color-success);
  }

  .demo-links {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
  }

  .demo-link {
    display: flex;
    flex-direction: column;
    padding: 20px;
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    text-decoration: none;
    transition: all 0.2s;
  }

  .demo-link:hover {
    border-color: var(--smrt-color-primary);
    box-shadow: 0 4px 12px var(--smrt-color-primary-container);
  }

  .demo-link .icon {
    font-size: 2rem;
    margin-bottom: 8px;
  }

  .demo-link .label {
    font-weight: 600;
    color: var(--smrt-color-on-surface);
    margin-bottom: 4px;
  }

  .demo-link .desc {
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface-variant);
  }
</style>
