<script lang="ts">
import { useLLM } from '@happyvertical/smrt-svelte';
import {
  CapabilityGate,
  DownloadProgress,
} from '@happyvertical/smrt-svelte/browser-ai/svelte';

const llm = useLLM({
  systemPrompt: 'You are a helpful assistant. Keep responses concise.',
});

let input = $state('');
let messages = $state<Array<{ role: 'user' | 'assistant'; content: string }>>(
  [],
);
let streamingResponse = $state('');

async function handleSubmit(e: Event) {
  e.preventDefault();
  if (!input.trim() || llm.isGenerating) return;

  const userMessage = input.trim();
  input = '';

  messages = [...messages, { role: 'user', content: userMessage }];
  streamingResponse = '';

  try {
    const response = await llm.chat(userMessage, {
      onToken: (token) => {
        streamingResponse += token;
      },
    });

    messages = [...messages, { role: 'assistant', content: response }];
    streamingResponse = '';
  } catch (error) {}
}

function clearChat() {
  messages = [];
  streamingResponse = '';
}
</script>

<h1>LLM Chat</h1>
<p class="description">
  Chat with a local AI model running in your browser via WebLLM.
</p>

<CapabilityGate require="llm">
  {#if llm.isInitializing}
    <section>
      <h2>Loading Model</h2>
      <DownloadProgress
        progress={{
          state: 'downloading',
          percent: llm.downloadProgress,
          bytesLoaded: 0,
          bytesTotal: 0
        }}
        label="Downloading model..."
        showPercent
      />
      <p class="loading-note">
        First load downloads the model (~250MB-2GB). It's cached for future use.
      </p>
    </section>
  {:else}
    <section>
      <div class="chat-header">
        <h2>Chat</h2>
        <div class="chat-actions">
          {#if llm.currentModel}
            <span class="model-badge">{llm.currentModel}</span>
          {/if}
          {#if messages.length > 0}
            <button class="clear-btn" onclick={clearChat}>Clear</button>
          {/if}
        </div>
      </div>

      <div class="chat-container">
        <div class="messages">
          {#if messages.length === 0 && !streamingResponse}
            <div class="empty-state">
              <p>Send a message to start chatting!</p>
              <p class="hint">Try: "What is WebLLM?" or "Write a haiku about coding"</p>
            </div>
          {/if}

          {#each messages as message}
            <div class="message {message.role}">
              <div class="message-role">{message.role === 'user' ? 'You' : 'AI'}</div>
              <div class="message-content">{message.content}</div>
            </div>
          {/each}

          {#if streamingResponse}
            <div class="message assistant">
              <div class="message-role">AI</div>
              <div class="message-content">{streamingResponse}<span class="cursor">▊</span></div>
            </div>
          {/if}
        </div>

        <form class="input-form" onsubmit={handleSubmit}>
          <input
            type="text"
            bind:value={input}
            placeholder="Type a message..."
            disabled={llm.isGenerating || !llm.isReady}
          />
          <button type="submit" disabled={llm.isGenerating || !llm.isReady || !input.trim()}>
            {llm.isGenerating ? 'Thinking...' : 'Send'}
          </button>
        </form>
      </div>
    </section>
  {/if}

  {#snippet fallback()}
    <div class="not-available">
      <p>LLM is not available in this browser.</p>
      <p>WebLLM requires WebGPU support. Try Chrome 113+ or Edge 113+.</p>
    </div>
  {/snippet}
</CapabilityGate>

<section>
  <h2>Info</h2>
  <table class="info-table">
    <tbody>
      <tr>
        <td>Status</td>
        <td>{llm.isReady ? 'Ready' : llm.isInitializing ? 'Loading...' : 'Not loaded'}</td>
      </tr>
      <tr>
        <td>Model</td>
        <td>{llm.currentModel ?? 'None'}</td>
      </tr>
      <tr>
        <td>Generating</td>
        <td>{llm.isGenerating ? 'Yes' : 'No'}</td>
      </tr>
      {#if llm.error}
        <tr>
          <td>Error</td>
          <td class="error">{llm.error.message}</td>
        </tr>
      {/if}
    </tbody>
  </table>

  {#if llm.isReady}
    <button class="unload-btn" onclick={() => llm.unload()}>
      Unload Model (Free Memory)
    </button>
  {:else if !llm.isInitializing}
    <button class="load-btn" onclick={() => llm.initialize()}>
      Load Model
    </button>
  {/if}
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

  .loading-note {
    margin-top: 12px;
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface-variant);
  }

  .chat-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .chat-header h2 {
    margin-bottom: 0;
    border-bottom: none;
    padding-bottom: 0;
  }

  .chat-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .model-badge {
    padding: 4px 8px;
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    border-radius: var(--smrt-radius-sm, 4px);
    font-size: 0.75rem;
    font-weight: 500;
  }

  .clear-btn {
    padding: 4px 12px;
    background: var(--smrt-color-surface-container);
    border: none;
    border-radius: var(--smrt-radius-sm, 4px);
    color: var(--smrt-color-on-surface-variant);
    cursor: pointer;
    font-size: 0.75rem;
  }

  .chat-container {
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-lg, 12px);
    overflow: hidden;
  }

  .messages {
    min-height: 300px;
    max-height: 500px;
    overflow-y: auto;
    padding: 16px;
  }

  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--smrt-color-on-surface-variant);
  }

  .empty-state .hint {
    font-size: 0.875rem;
    margin-top: 8px;
  }

  .message {
    margin-bottom: 16px;
  }

  .message-role {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--smrt-color-on-surface-variant);
    margin-bottom: 4px;
  }

  .message.user .message-role {
    color: var(--smrt-color-primary);
  }

  .message.assistant .message-role {
    color: var(--smrt-color-success);
  }

  .message-content {
    padding: 12px 16px;
    border-radius: var(--smrt-radius-md, 8px);
    background: var(--smrt-color-surface-container);
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .message.user .message-content {
    background: var(--smrt-color-primary-container);
  }

  .cursor {
    animation: blink 1s infinite;
  }

  @keyframes blink {
    0%, 50% { opacity: 1; }
    51%, 100% { opacity: 0; }
  }

  .input-form {
    display: flex;
    gap: 8px;
    padding: 16px;
    border-top: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface-container);
  }

  .input-form input {
    flex: 1;
    padding: 12px 16px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
    font-size: 0.875rem;
  }

  .input-form input:focus {
    outline: none;
    border-color: var(--smrt-color-primary);
  }

  .input-form button {
    padding: 12px 24px;
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    border: none;
    border-radius: var(--smrt-radius-md, 8px);
    font-weight: 500;
    cursor: pointer;
  }

  .input-form button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .not-available {
    padding: 40px;
    text-align: center;
    background: var(--smrt-color-error-container);
    border: 1px solid var(--smrt-color-error);
    border-radius: var(--smrt-radius-md, 8px);
    color: var(--smrt-color-on-error-container);
  }

  .info-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 16px;
  }

  .info-table td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .info-table td:first-child {
    font-weight: 500;
    color: var(--smrt-color-on-surface-variant);
    width: 120px;
  }

  .info-table .error {
    color: var(--smrt-color-error);
  }

  .unload-btn,
  .load-btn {
    padding: 8px 16px;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    cursor: pointer;
    font-size: 0.875rem;
  }

  .unload-btn:hover,
  .load-btn:hover {
    background: var(--smrt-color-surface-container);
  }

  .load-btn {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    border-color: var(--smrt-color-primary);
  }

  .load-btn:hover {
    background: var(--smrt-color-primary);
  }
</style>
