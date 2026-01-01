<script lang="ts">
import type {
  LLMModelId,
  SelectOption,
  STTAdapterType,
} from '@happyvertical/smrt-svelte';

let _name = $state('');
let _email = $state('');
let _phone = $state('');
let _birthday = $state('');
let _age = $state<number | null>(null);
let _department = $state('');
let _notes = $state('');
let _newsletter = $state(false);
const _appendMode = $state(false);
let _submittedData = $state<Record<string, unknown> | null>(null);

const _departmentOptions: SelectOption[] = [
  { value: 'engineering', label: 'Engineering' },
  { value: 'sales', label: 'Sales' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'support', label: 'Customer Support' },
  { value: 'hr', label: 'Human Resources' },
];

// Control panel state
const _sttAdapter = $state<STTAdapterType>('whisper-wasm');
const _llmModel = $state<LLMModelId>('none');

const _sttOptions: {
  value: STTAdapterType;
  label: string;
  description: string;
}[] = [
  {
    value: 'browser',
    label: 'Browser (Web Speech API)',
    description: 'Fast, no download, requires internet',
  },
  {
    value: 'whisper-wasm',
    label: 'Whisper WASM',
    description: 'Offline, ~40MB download, high accuracy',
  },
];

const _llmOptions: { value: LLMModelId; label: string; size: string }[] = [
  { value: 'none', label: 'None (Regex only)', size: '0' },
  { value: 'smollm2-360m', label: 'SmolLM2 360M', size: '~250MB' },
  { value: 'smollm2-1.7b', label: 'SmolLM2 1.7B', size: '~1.1GB' },
  { value: 'qwen2.5-1.5b', label: 'Qwen2.5 1.5B', size: '~1GB' },
  { value: 'llama-3.2-1b', label: 'Llama 3.2 1B', size: '~800MB' },
];

function _handleSubmit(data: Record<string, unknown>) {
  _submittedData = data;
  console.log('Form submitted:', data);
}

function _clearForm() {
  _name = '';
  _email = '';
  _phone = '';
  _birthday = '';
  _age = null;
  _department = '';
  _notes = '';
  _newsletter = false;
  _submittedData = null;
}
</script>

<div class="page">
  <h1>SMRT Forms</h1>
  <p class="description">
    Voice-enabled form components. Toggle to <strong>Smrt</strong> mode to enable voice input.
  </p>

  <div class="control-panel">
    <h2>AI Settings</h2>
    <div class="control-grid">
      <div class="control-group">
        <label for="stt-select">Speech-to-Text Engine</label>
        <select id="stt-select" bind:value={sttAdapter}>
          {#each sttOptions as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
        <span class="control-hint">
          {sttOptions.find(o => o.value === sttAdapter)?.description}
        </span>
      </div>

      <div class="control-group">
        <label for="llm-select">Field Extraction Model</label>
        <select id="llm-select" bind:value={llmModel}>
          {#each llmOptions as opt (opt.value)}
            <option value={opt.value}>{opt.label} ({opt.size})</option>
          {/each}
        </select>
        <span class="control-hint">
          {#if llmModel === 'none'}
            Uses regex patterns to extract field values (fast, reliable)
          {:else}
            Uses LLM for smart extraction (requires WebGPU)
          {/if}
        </span>
      </div>
    </div>

    <div class="control-actions">
      <button type="button" class="clear-btn" onclick={clearForm}>
        Clear Form
      </button>
    </div>
  </div>

  <div class="demo-section">
    <h2>User Registration Form</h2>
    <p class="hint">
      In Smrt mode: Click the "Speak all fields" button and say field names followed by values.
      Say "done" when finished, or wait for silence timeout.
    </p>

    <SMRTForm onsubmit={handleSubmit} {sttAdapter} {llmModel}>
      <SMRTTextInput
        name="name"
        label="Full Name"
        description="Person's full legal name"
        placeholder="Enter your name..."
        bind:value={name}
        required
      />

      <SMRTTextInput
        name="email"
        label="Email Address"
        type="email"
        description="Email address for contact"
        placeholder="Enter your email..."
        bind:value={email}
        required
      />

      <SMRTPhone
        name="phone"
        label="Phone Number"
        description="Contact phone number"
        bind:value={phone}
      />

      <SMRTDateTime
        name="birthday"
        label="Birthday"
        description="Date of birth"
        includeTime={false}
        bind:value={birthday}
      />

      <SMRTNumber
        name="age"
        label="Age"
        description="Person's age in years"
        placeholder="Enter age..."
        min={0}
        max={150}
        bind:value={age}
      />

      <SMRTSelect
        name="department"
        label="Department"
        description="Work department"
        options={departmentOptions}
        bind:value={department}
      />

      <div class="append-toggle">
        <label>
          <input type="checkbox" bind:checked={appendMode} />
          Append mode (add to existing text instead of replacing)
        </label>
      </div>

      <SMRTTextarea
        name="notes"
        label="Notes"
        description="Additional notes or comments"
        placeholder="Add notes... (try speaking multiple times with append mode)"
        bind:value={notes}
        rows={3}
        {appendMode}
      />

      <SMRTCheckbox
        name="newsletter"
        label="Subscribe to newsletter"
        description="Whether to receive newsletter emails"
        bind:checked={newsletter}
      />

      <div class="form-actions">
        <button type="submit" class="submit-btn">
          Submit
        </button>
      </div>
    </SMRTForm>

    {#if submittedData}
      <div class="submitted-data">
        <h3>Submitted Data:</h3>
        <pre>{JSON.stringify(submittedData, null, 2)}</pre>
      </div>
    {/if}
  </div>

  <div class="demo-section">
    <h2>Current Values</h2>
    <div class="values-grid">
      <div class="value-item">
        <span class="label">Name:</span>
        <span class="value">{name || '(empty)'}</span>
      </div>
      <div class="value-item">
        <span class="label">Email:</span>
        <span class="value">{email || '(empty)'}</span>
      </div>
      <div class="value-item">
        <span class="label">Phone:</span>
        <span class="value">{phone || '(empty)'}</span>
      </div>
      <div class="value-item">
        <span class="label">Birthday:</span>
        <span class="value">{birthday || '(empty)'}</span>
      </div>
      <div class="value-item">
        <span class="label">Age:</span>
        <span class="value">{age ?? '(empty)'}</span>
      </div>
      <div class="value-item">
        <span class="label">Department:</span>
        <span class="value">{department || '(empty)'}</span>
      </div>
      <div class="value-item">
        <span class="label">Notes:</span>
        <span class="value">{notes || '(empty)'}</span>
      </div>
      <div class="value-item">
        <span class="label">Newsletter:</span>
        <span class="value">{newsletter ? 'Yes' : 'No'}</span>
      </div>
    </div>
  </div>

  <div class="demo-section">
    <h2>How It Works</h2>
    <div class="features">
      <div class="feature">
        <h3>Dumb Mode</h3>
        <ul>
          <li>Standard HTML form inputs</li>
          <li>Native date picker for birthday</li>
          <li>No AI features</li>
        </ul>
      </div>
      <div class="feature">
        <h3>Smrt Mode</h3>
        <ul>
          <li>Click "Speak all fields" to record</li>
          <li>Speech transcribed via {sttAdapter === 'browser' ? 'Web Speech API' : 'Whisper'}</li>
          <li>Fields extracted via {llmModel === 'none' ? 'regex patterns' : llmModel}</li>
          <li>Say "done" or wait for silence to finish</li>
        </ul>
      </div>
    </div>
  </div>

  <div class="demo-section">
    <h2>Try These Voice Commands</h2>
    <div class="examples">
      <p><strong>Speak field names followed by values:</strong></p>
      <ul>
        <li>"name Will Griffin"</li>
        <li>"email address will@gmail.com"</li>
        <li>"phone number 555 123 4567"</li>
        <li>"birthday June 16 1978"</li>
        <li>"age forty six"</li>
        <li>"department engineering"</li>
        <li>"newsletter yes"</li>
        <li>"done" (to finish)</li>
      </ul>
      <p><strong>Or all at once:</strong></p>
      <ul>
        <li>"name Will Griffin email will@gmail.com phone 555 123 4567 age 46 department sales done"</li>
      </ul>
    </div>
  </div>
</div>

<style>
  .page {
    max-width: 800px;
  }

  h1 {
    font-size: 1.75rem;
    color: #1f2937;
    margin-bottom: 8px;
  }

  h2 {
    font-size: 1.25rem;
    color: #374151;
    margin-bottom: 16px;
  }

  h3 {
    font-size: 1rem;
    color: #4b5563;
    margin-bottom: 8px;
  }

  .description {
    color: #6b7280;
    margin-bottom: 32px;
  }

  .hint {
    font-size: 0.875rem;
    color: #6b7280;
    background: #f9fafb;
    padding: 12px 16px;
    border-radius: 8px;
    margin-bottom: 24px;
  }

  .control-panel {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 24px;
  }

  .control-panel h2 {
    color: white;
    margin-bottom: 16px;
    font-size: 1rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .control-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
  }

  @media (max-width: 600px) {
    .control-grid {
      grid-template-columns: 1fr;
    }
  }

  .control-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .control-group label {
    font-size: 0.875rem;
    font-weight: 500;
  }

  .control-group select {
    padding: 10px 12px;
    border: none;
    border-radius: 8px;
    font-size: 0.875rem;
    background: rgba(255, 255, 255, 0.9);
    color: #1f2937;
    cursor: pointer;
  }

  .control-group select:focus {
    outline: 2px solid white;
    outline-offset: 2px;
  }

  .control-hint {
    font-size: 0.75rem;
    opacity: 0.8;
  }

  .control-actions {
    margin-top: 16px;
    display: flex;
    gap: 12px;
  }

  .clear-btn {
    padding: 8px 16px;
    background: rgba(255, 255, 255, 0.2);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 6px;
    font-size: 0.875rem;
    cursor: pointer;
    transition: background 0.2s;
  }

  .clear-btn:hover {
    background: rgba(255, 255, 255, 0.3);
  }

  .demo-section {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 24px;
  }

  .form-actions {
    margin-top: 8px;
    display: flex;
    justify-content: flex-end;
  }

  .submit-btn {
    padding: 10px 24px;
    background: #3b82f6;
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s;
  }

  .submit-btn:hover {
    background: #2563eb;
  }

  .submitted-data {
    margin-top: 24px;
    padding: 16px;
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    border-radius: 8px;
  }

  .submitted-data h3 {
    color: #166534;
    margin-bottom: 8px;
  }

  .submitted-data pre {
    background: #fff;
    padding: 12px;
    border-radius: 4px;
    font-size: 0.875rem;
    overflow-x: auto;
  }

  .values-grid {
    display: grid;
    gap: 12px;
  }

  .value-item {
    display: flex;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid #e5e7eb;
  }

  .value-item:last-child {
    border-bottom: none;
  }

  .value-item .label {
    font-weight: 500;
    color: #374151;
    min-width: 80px;
  }

  .value-item .value {
    color: #6b7280;
    font-family: monospace;
  }

  .features {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
  }

  @media (max-width: 600px) {
    .features {
      grid-template-columns: 1fr;
    }
  }

  .feature {
    padding: 16px;
    background: #f9fafb;
    border-radius: 8px;
  }

  .feature ul {
    margin: 0;
    padding-left: 20px;
    color: #6b7280;
    font-size: 0.875rem;
  }

  .feature li {
    margin: 4px 0;
  }

  .examples {
    font-size: 0.875rem;
    color: #4b5563;
  }

  .examples ul {
    margin: 8px 0 16px;
    padding-left: 20px;
  }

  .examples li {
    margin: 4px 0;
    font-family: monospace;
    background: #f3f4f6;
    padding: 4px 8px;
    border-radius: 4px;
    display: inline-block;
    margin-right: 8px;
    margin-bottom: 8px;
  }

  .append-toggle {
    padding: 12px;
    background: #f9fafb;
    border-radius: 8px;
    font-size: 0.875rem;
  }

  .append-toggle label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    color: #4b5563;
  }

  .append-toggle input[type="checkbox"] {
    width: 18px;
    height: 18px;
    cursor: pointer;
  }
</style>
