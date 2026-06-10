<script lang="ts">
import type {
  LLMModelId,
  SelectOption,
  STTAdapterType,
} from '@happyvertical/smrt-svelte';
import {
  CheckboxInput,
  DateTimeInput,
  Form,
  NumberInput,
  PhoneInput,
  SearchInput,
  SelectInput,
  TextareaInput,
  TextInput,
  Toggle,
} from '@happyvertical/smrt-svelte';

let name = $state('');
let email = $state('');
let phone = $state('');
let birthday = $state('');
let age = $state<number | null>(null);
let department = $state('');
let notes = $state('');
let newsletter = $state(false);
let appendMode = $state(false);
let submittedData = $state<Record<string, unknown> | null>(null);

// Search state
let searchValue = $state('');
let searchLoading = $state(false);
let searchResults = $state<string[]>([]);

// Toggle state
let darkMode = $state(false);
let notifications = $state(true);
let autoSave = $state(false);

const departmentOptions: SelectOption[] = [
  { value: 'engineering', label: 'Engineering' },
  { value: 'sales', label: 'Sales' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'support', label: 'Customer Support' },
  { value: 'hr', label: 'Human Resources' },
];

// Control panel state
let sttAdapter = $state<STTAdapterType>('whisper-wasm');
let llmModel = $state<LLMModelId>('none');

const sttOptions: {
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

const llmOptions: { value: LLMModelId; label: string; size: string }[] = [
  { value: 'none', label: 'None (Regex only)', size: '0' },
  { value: 'smollm2-360m', label: 'SmolLM2 360M', size: '~250MB' },
  { value: 'smollm2-1.7b', label: 'SmolLM2 1.7B', size: '~1.1GB' },
  { value: 'qwen2.5-1.5b', label: 'Qwen2.5 1.5B', size: '~1GB' },
  { value: 'llama-3.2-1b', label: 'Llama 3.2 1B', size: '~800MB' },
];

function handleSubmit(data: Record<string, unknown>) {
  submittedData = data;
}

function clearForm() {
  name = '';
  email = '';
  phone = '';
  birthday = '';
  age = null;
  department = '';
  notes = '';
  newsletter = false;
  submittedData = null;
}

function handleSearch(value: string) {
  searchLoading = true;
  // Simulate search
  setTimeout(() => {
    searchResults = value
      ? [
          `Result 1 for ${value}`,
          `Result 2 for ${value}`,
          `Result 3 for ${value}`,
        ]
      : [];
    searchLoading = false;
  }, 500);
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

    <Form onsubmit={handleSubmit} {sttAdapter} {llmModel}>
      <TextInput
        name="name"
        label="Full Name"
        description="Person's full legal name"
        placeholder="Enter your name..."
        bind:value={name}
        required
      />

      <TextInput
        name="email"
        label="Email Address"
        type="email"
        description="Email address for contact"
        placeholder="Enter your email..."
        bind:value={email}
        required
      />

      <PhoneInput
        name="phone"
        label="Phone Number"
        description="Contact phone number"
        bind:value={phone}
      />

      <DateTimeInput
        name="birthday"
        label="Birthday"
        description="Date of birth"
        includeTime={false}
        bind:value={birthday}
      />

      <NumberInput
        name="age"
        label="Age"
        description="Person's age in years"
        placeholder="Enter age..."
        min={0}
        max={150}
        bind:value={age}
      />

      <SelectInput
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

      <TextareaInput
        name="notes"
        label="Notes"
        description="Additional notes or comments"
        placeholder="Add notes... (try speaking multiple times with append mode)"
        bind:value={notes}
        rows={3}
        {appendMode}
      />

      <CheckboxInput
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
    </Form>

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
        <h3>Default Mode</h3>
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

  <div class="demo-section">
    <h2>SearchInput</h2>
    <p class="hint">Search input with debounce, loading state, and clear button.</p>

    <h3>Basic Search</h3>
    <div class="input-demo">
      <SearchInput
        bind:value={searchValue}
        placeholder="Search users..."
        loading={searchLoading}
        onsearch={handleSearch}
      />
    </div>
    <p class="search-state">Search: "{searchValue}" | Loading: {searchLoading}</p>
    {#if searchResults.length > 0}
      <ul class="search-results">
        {#each searchResults as result}
          <li>{result}</li>
        {/each}
      </ul>
    {/if}

    <h3>Size Variants</h3>
    <div class="input-demo-grid">
      <div>
        <span class="size-label">Small</span>
        <SearchInput size="sm" placeholder="Small search..." />
      </div>
      <div>
        <span class="size-label">Medium</span>
        <SearchInput size="md" placeholder="Medium search..." />
      </div>
      <div>
        <span class="size-label">Large</span>
        <SearchInput size="lg" placeholder="Large search..." />
      </div>
    </div>
  </div>

  <div class="demo-section">
    <h2>Toggle</h2>
    <p class="hint">Accessible toggle switch with label positioning.</p>

    <h3>Basic Toggles</h3>
    <div class="toggle-demos">
      <Toggle
        label="Dark Mode"
        bind:checked={darkMode}
      />
      <Toggle
        label="Notifications"
        bind:checked={notifications}
      />
      <Toggle
        label="Auto-save"
        bind:checked={autoSave}
      />
    </div>
    <p class="toggle-state">Dark: {darkMode} | Notifications: {notifications} | Auto-save: {autoSave}</p>

    <h3>Label Positions</h3>
    <div class="toggle-demos">
      <Toggle
        label="Label on right"
        labelPosition="right"
        checked={true}
      />
      <Toggle
        label="Label on left"
        labelPosition="left"
        checked={true}
      />
    </div>

    <h3>Size Variants</h3>
    <div class="toggle-demos">
      <Toggle label="Small" size="sm" checked={true} />
      <Toggle label="Medium" size="md" checked={true} />
      <Toggle label="Large" size="lg" checked={true} />
    </div>

    <h3>Disabled State</h3>
    <div class="toggle-demos">
      <Toggle label="Disabled off" disabled />
      <Toggle label="Disabled on" disabled checked={true} />
    </div>
  </div>
</div>

<style>
  .page {
    max-width: 800px;
  }

  h1 {
    font-size: 1.75rem;
    color: var(--smrt-color-on-surface);
    margin-bottom: 8px;
  }

  h2 {
    font-size: 1.25rem;
    color: var(--smrt-color-on-surface);
    margin-bottom: 16px;
  }

  h3 {
    font-size: 1rem;
    color: var(--smrt-color-on-surface-variant);
    margin-bottom: 8px;
  }

  .description {
    color: var(--smrt-color-on-surface-variant);
    margin-bottom: 32px;
  }

  .hint {
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface-variant);
    background: var(--smrt-color-surface-container);
    padding: 12px 16px;
    border-radius: var(--smrt-radius-md, 8px);
    margin-bottom: 24px;
  }

  .control-panel {
    background: linear-gradient(135deg, var(--smrt-color-primary) 0%, var(--smrt-color-tertiary, #764ba2) 100%);
    color: var(--smrt-color-on-primary);
    border-radius: var(--smrt-radius-lg, 12px);
    padding: 24px;
    margin-bottom: 24px;
  }

  .control-panel h2 {
    color: var(--smrt-color-on-primary);
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
    border-radius: var(--smrt-radius-md, 8px);
    font-size: 0.875rem;
    background: rgba(255, 255, 255, 0.9);
    color: var(--smrt-color-on-surface);
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
    color: var(--smrt-color-on-primary);
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: var(--smrt-radius-md, 8px);
    font-size: 0.875rem;
    cursor: pointer;
    transition: background 0.2s;
  }

  .clear-btn:hover {
    background: rgba(255, 255, 255, 0.3);
  }

  .demo-section {
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-lg, 12px);
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
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    border: none;
    border-radius: var(--smrt-radius-md, 8px);
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s;
  }

  .submit-btn:hover {
    background: var(--smrt-color-primary);
  }

  .submitted-data {
    margin-top: 24px;
    padding: 16px;
    background: var(--smrt-color-success-container, #f0fdf4);
    border: 1px solid var(--smrt-color-success, #bbf7d0);
    border-radius: var(--smrt-radius-md, 8px);
  }

  .submitted-data h3 {
    color: var(--smrt-color-on-success-container, #166534);
    margin-bottom: 8px;
  }

  .submitted-data pre {
    background: var(--smrt-color-surface);
    padding: 12px;
    border-radius: var(--smrt-radius-sm, 4px);
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
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .value-item:last-child {
    border-bottom: none;
  }

  .value-item .label {
    font-weight: 500;
    color: var(--smrt-color-on-surface);
    min-width: 80px;
  }

  .value-item .value {
    color: var(--smrt-color-on-surface-variant);
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
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-md, 8px);
  }

  .feature ul {
    margin: 0;
    padding-left: 20px;
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.875rem;
  }

  .feature li {
    margin: 4px 0;
  }

  .examples {
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface-variant);
  }

  .examples ul {
    margin: 8px 0 16px;
    padding-left: 20px;
  }

  .examples li {
    margin: 4px 0;
    font-family: monospace;
    background: var(--smrt-color-surface-container);
    padding: 4px 8px;
    border-radius: var(--smrt-radius-sm, 4px);
    display: inline-block;
    margin-right: 8px;
    margin-bottom: 8px;
  }

  .append-toggle {
    padding: 12px;
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-md, 8px);
    font-size: 0.875rem;
  }

  .append-toggle label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    color: var(--smrt-color-on-surface-variant);
  }

  .append-toggle input[type="checkbox"] {
    width: 18px;
    height: 18px;
    cursor: pointer;
  }

  .input-demo {
    max-width: 400px;
  }

  .input-demo-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
  }

  @media (max-width: 600px) {
    .input-demo-grid {
      grid-template-columns: 1fr;
    }
  }

  .size-label {
    display: block;
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
    margin-bottom: 4px;
  }

  .search-state {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
    margin-top: 8px;
    font-family: monospace;
  }

  .search-results {
    margin-top: 12px;
    padding: 12px;
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-md, 8px);
    list-style: none;
  }

  .search-results li {
    padding: 8px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .search-results li:last-child {
    border-bottom: none;
  }

  .toggle-demos {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin-bottom: 16px;
  }

  .toggle-state {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
    font-family: monospace;
  }
</style>
