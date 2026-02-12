<script lang="ts">
import {
  CapabilityGate,
  DownloadProgress,
  useLLM,
  useSTT,
  VoiceInput,
} from '@happyvertical/smrt-svelte';

const stt = useSTT();
const llm = useLLM({
  systemPrompt:
    'You are a helpful voice assistant. Keep responses concise and conversational.',
});

let conversation = $state<
  Array<{ role: 'user' | 'assistant'; content: string }>
>([]);
let streamingResponse = $state('');
let isProcessing = $state(false);

async function handleTranscription(text: string) {
  if (!text.trim() || isProcessing) return;

  isProcessing = true;

  // Add user message
  conversation = [...conversation, { role: 'user', content: text }];
  streamingResponse = '';

  try {
    // Get LLM response
    const response = await llm.chat(text, {
      onToken: (token) => {
        streamingResponse += token;
      },
    });

    // Add assistant response
    conversation = [...conversation, { role: 'assistant', content: response }];
    streamingResponse = '';
  } catch (error) {
    console.error('Pipeline error:', error);
  } finally {
    isProcessing = false;
  }
}

function clearConversation() {
  conversation = [];
  streamingResponse = '';
}
</script>

<h1>Voice → LLM Pipeline</h1>
<p class="description">
  Speak and get AI responses. The complete pipeline: Speech Recognition → LLM → Response.
</p>

<CapabilityGate require="stt">
  <CapabilityGate require="llm">
    {#if llm.isInitializing}
      <section>
        <h2>Loading AI Model</h2>
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
      </section>
    {:else}
      <section>
        <h2>Voice Input</h2>
        <div class="voice-section">
          <VoiceInput
            onTranscription={handleTranscription}
            language="en-US"
            size="lg"
            disabled={isProcessing || !llm.isReady}
          />

          <div class="status">
            {#if stt.isListening}
              <span class="listening">Listening...</span>
            {:else if isProcessing}
              <span class="processing">Processing with AI...</span>
            {:else if !llm.isReady}
              <span class="loading">Loading model...</span>
            {:else}
              <span class="ready">Click mic and speak</span>
            {/if}
          </div>
        </div>
      </section>

      <section>
        <div class="section-header">
          <h2>Conversation</h2>
          {#if conversation.length > 0}
            <button class="clear-btn" onclick={clearConversation}>Clear</button>
          {/if}
        </div>

        <div class="conversation">
          {#if conversation.length === 0 && !streamingResponse}
            <div class="empty-state">
              <p>Click the microphone and ask a question!</p>
              <p class="examples">
                Try: "What's the weather like?" or "Tell me a joke"
              </p>
            </div>
          {:else}
            {#each conversation as message}
              <div class="message {message.role}">
                <div class="message-icon">
                  {message.role === 'user' ? '🎤' : '🤖'}
                </div>
                <div class="message-content">{message.content}</div>
              </div>
            {/each}

            {#if streamingResponse}
              <div class="message assistant">
                <div class="message-icon">🤖</div>
                <div class="message-content">
                  {streamingResponse}<span class="cursor">▊</span>
                </div>
              </div>
            {/if}
          {/if}
        </div>
      </section>
    {/if}

    {#snippet fallback()}
      <div class="not-available">
        <p>LLM requires WebGPU support.</p>
        <p>Try Chrome 113+ or Edge 113+.</p>
      </div>
    {/snippet}
  </CapabilityGate>

  {#snippet fallback()}
    <div class="not-available">
      <p>Speech recognition is not available.</p>
      <p>Try Chrome, Edge, or Safari.</p>
    </div>
  {/snippet}
</CapabilityGate>

<section>
  <h2>Pipeline Status</h2>
  <div class="pipeline-status">
    <div class="pipeline-step" class:active={stt.isListening}>
      <span class="step-icon">🎤</span>
      <span class="step-label">STT</span>
      <span class="step-status">
        {stt.isListening ? 'Listening' : stt.isReady ? 'Ready' : 'Init'}
      </span>
    </div>
    <div class="pipeline-arrow">→</div>
    <div class="pipeline-step" class:active={isProcessing}>
      <span class="step-icon">🤖</span>
      <span class="step-label">LLM</span>
      <span class="step-status">
        {isProcessing ? 'Generating' : llm.isReady ? 'Ready' : 'Loading'}
      </span>
    </div>
    <div class="pipeline-arrow">→</div>
    <div class="pipeline-step" class:active={!!streamingResponse}>
      <span class="step-icon">💬</span>
      <span class="step-label">Response</span>
      <span class="step-status">
        {streamingResponse ? 'Streaming' : 'Waiting'}
      </span>
    </div>
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

  .voice-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    padding: 40px;
    background: linear-gradient(135deg, var(--smrt-color-primary-container) 0%, var(--smrt-color-success-container, #f0fdf4) 100%);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 16px;
  }

  .status {
    font-size: 0.875rem;
    font-weight: 500;
  }

  .status .listening {
    color: var(--smrt-color-error);
  }

  .status .processing {
    color: var(--smrt-color-primary);
  }

  .status .loading {
    color: var(--smrt-color-warning);
  }

  .status .ready {
    color: var(--smrt-color-on-surface-variant);
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .section-header h2 {
    margin-bottom: 0;
    border-bottom: none;
    padding-bottom: 0;
  }

  .clear-btn {
    padding: 4px 12px;
    background: var(--smrt-color-surface-container);
    border: none;
    border-radius: 4px;
    color: var(--smrt-color-on-surface-variant);
    cursor: pointer;
    font-size: 0.75rem;
  }

  .conversation {
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 12px;
    min-height: 300px;
    padding: 16px;
  }

  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--smrt-color-on-surface-variant);
  }

  .empty-state .examples {
    font-size: 0.875rem;
    margin-top: 8px;
  }

  .message {
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
  }

  .message-icon {
    font-size: 1.5rem;
    flex-shrink: 0;
  }

  .message-content {
    flex: 1;
    padding: 12px 16px;
    border-radius: 12px;
    background: var(--smrt-color-surface-container);
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .message.user .message-content {
    background: var(--smrt-color-primary-container);
  }

  .message.assistant .message-content {
    background: var(--smrt-color-success-container, #f0fdf4);
  }

  .cursor {
    animation: blink 1s infinite;
  }

  @keyframes blink {
    0%, 50% { opacity: 1; }
    51%, 100% { opacity: 0; }
  }

  .not-available {
    padding: 40px;
    text-align: center;
    background: var(--smrt-color-error-container);
    border: 1px solid var(--smrt-color-error);
    border-radius: 8px;
    color: var(--smrt-color-on-error-container);
  }

  .pipeline-status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 24px;
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 12px;
  }

  .pipeline-step {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 16px 24px;
    background: var(--smrt-color-surface-container);
    border-radius: 8px;
    transition: all 0.2s;
  }

  .pipeline-step.active {
    background: var(--smrt-color-primary-container);
    box-shadow: 0 0 0 2px var(--smrt-color-primary);
  }

  .step-icon {
    font-size: 1.5rem;
  }

  .step-label {
    font-weight: 600;
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface);
  }

  .step-status {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
  }

  .pipeline-arrow {
    font-size: 1.5rem;
    color: var(--smrt-color-outline-variant);
  }
</style>
