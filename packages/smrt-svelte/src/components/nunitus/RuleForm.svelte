<script lang="ts">
/**
 * RuleForm - Create and edit routing rules
 *
 * Features:
 * - Create new rules or edit existing ones
 * - Form validation
 * - Regex pattern tester
 * - AI condition builder
 * - Priority slider
 * - Category selection
 */

interface Rule {
  id?: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  category: string;
  signalType: string;
  regexPatterns: {
    subject?: string;
    from?: string;
    body?: string;
  };
  aiCondition: string;
}

interface Props {
  rule?: Rule | null;
  onSave?: (rule: Rule) => void;
  onCancel?: () => void;
}

let { rule = null, onSave, onCancel }: Props = $props();

// Categories available
const categories = [
  { value: 'support', label: 'Support', color: 'blue' },
  { value: 'sales', label: 'Sales', color: 'green' },
  { value: 'legal', label: 'Legal', color: 'red' },
  { value: 'ops', label: 'Operations', color: 'purple' },
  { value: 'dev', label: 'Development', color: 'yellow' },
  { value: 'product', label: 'Product', color: 'pink' },
  { value: 'content', label: 'Content', color: 'indigo' },
];

// Form state
let formData = $state<Rule>({
  id: rule?.id,
  name: rule?.name || '',
  description: rule?.description || '',
  enabled: rule?.enabled ?? true,
  priority: rule?.priority ?? 50,
  category: rule?.category || 'support',
  signalType: rule?.signalType || 'message.email.support',
  regexPatterns: {
    subject: rule?.regexPatterns?.subject || '',
    from: rule?.regexPatterns?.from || '',
    body: rule?.regexPatterns?.body || '',
  },
  aiCondition: rule?.aiCondition || '',
});

// Validation errors
let errors = $state<Record<string, string>>({});

// Pattern tester
let testInput = $state({
  subject: '',
  from: '',
  body: '',
});

let testResults = $state<Record<string, boolean>>({});

function validateForm(): boolean {
  const newErrors: Record<string, string> = {};

  if (!formData.name.trim()) {
    newErrors.name = 'Name is required';
  }

  if (!formData.category) {
    newErrors.category = 'Category is required';
  }

  if (formData.priority < 0 || formData.priority > 100) {
    newErrors.priority = 'Priority must be between 0 and 100';
  }

  // Validate regex patterns
  const patterns = [
    { key: 'subject', value: formData.regexPatterns.subject },
    { key: 'from', value: formData.regexPatterns.from },
    { key: 'body', value: formData.regexPatterns.body },
  ];

  for (const pattern of patterns) {
    if (pattern.value) {
      try {
        new RegExp(pattern.value);
      } catch (e) {
        newErrors[`pattern_${pattern.key}`] = `Invalid regex: ${e.message}`;
      }
    }
  }

  // At least one pattern or AI condition required
  const hasPatterns = Object.values(formData.regexPatterns).some((p) => p);
  if (!hasPatterns && !formData.aiCondition.trim()) {
    newErrors.patterns =
      'At least one regex pattern or AI condition is required';
  }

  errors = newErrors;
  return Object.keys(newErrors).length === 0;
}

function handleSubmit() {
  if (validateForm()) {
    // Auto-generate signal type if not customized
    if (
      !formData.signalType ||
      formData.signalType === `message.email.${rule?.category}`
    ) {
      formData.signalType = `message.email.${formData.category}`;
    }
    onSave?.(formData);
  }
}

function handleCancel() {
  onCancel?.();
}

function testPatterns() {
  const results: Record<string, boolean> = {};

  if (formData.regexPatterns.subject) {
    try {
      const regex = new RegExp(formData.regexPatterns.subject, 'i');
      results.subject = regex.test(testInput.subject);
    } catch (e) {
      results.subject = false;
    }
  }

  if (formData.regexPatterns.from) {
    try {
      const regex = new RegExp(formData.regexPatterns.from, 'i');
      results.from = regex.test(testInput.from);
    } catch (e) {
      results.from = false;
    }
  }

  if (formData.regexPatterns.body) {
    try {
      const regex = new RegExp(formData.regexPatterns.body, 'i');
      results.body = regex.test(testInput.body);
    } catch (e) {
      results.body = false;
    }
  }

  testResults = results;
}

function clearTest() {
  testInput = { subject: '', from: '', body: '' };
  testResults = {};
}
</script>

<div class="rule-form">
  <form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
    <div class="form-header">
      <h2>{rule ? 'Edit Rule' : 'Create New Rule'}</h2>
    </div>

    <div class="form-body">
      <!-- Basic Info -->
      <div class="form-section">
        <h3>Basic Information</h3>

        <div class="form-group">
          <label for="name">Rule Name *</label>
          <input
            id="name"
            type="text"
            bind:value={formData.name}
            class:error={errors.name}
            placeholder="e.g., Support Tickets"
          />
          {#if errors.name}
            <span class="error-message">{errors.name}</span>
          {/if}
        </div>

        <div class="form-group">
          <label for="description">Description</label>
          <textarea
            id="description"
            bind:value={formData.description}
            placeholder="Describe what this rule does..."
            rows="3"
          ></textarea>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="category">Category *</label>
            <select id="category" bind:value={formData.category} class:error={errors.category}>
              {#each categories as cat}
                <option value={cat.value}>{cat.label}</option>
              {/each}
            </select>
            {#if errors.category}
              <span class="error-message">{errors.category}</span>
            {/if}
          </div>

          <div class="form-group">
            <label for="priority">
              Priority: {formData.priority}
              <span class="priority-hint">
                (0 = lowest, 100 = highest)
              </span>
            </label>
            <input
              id="priority"
              type="range"
              bind:value={formData.priority}
              min="0"
              max="100"
              step="5"
              class:error={errors.priority}
            />
            {#if errors.priority}
              <span class="error-message">{errors.priority}</span>
            {/if}
          </div>
        </div>

        <div class="form-group">
          <label for="enabled">
            <input id="enabled" type="checkbox" bind:checked={formData.enabled} />
            Enable this rule
          </label>
        </div>
      </div>

      <!-- Regex Patterns -->
      <div class="form-section">
        <h3>Regex Patterns</h3>
        <p class="section-description">
          Fast pre-filter using regular expressions. Case-insensitive matching.
        </p>

        {#if errors.patterns}
          <div class="error-message global">{errors.patterns}</div>
        {/if}

        <div class="form-group">
          <label for="subject-pattern">Subject Pattern</label>
          <input
            id="subject-pattern"
            type="text"
            bind:value={formData.regexPatterns.subject}
            class:error={errors.pattern_subject}
            placeholder="e.g., (bug|error|issue)"
          />
          {#if errors.pattern_subject}
            <span class="error-message">{errors.pattern_subject}</span>
          {/if}
        </div>

        <div class="form-group">
          <label for="from-pattern">From Pattern</label>
          <input
            id="from-pattern"
            type="text"
            bind:value={formData.regexPatterns.from}
            class:error={errors.pattern_from}
            placeholder="e.g., support@example\\.com"
          />
          {#if errors.pattern_from}
            <span class="error-message">{errors.pattern_from}</span>
          {/if}
        </div>

        <div class="form-group">
          <label for="body-pattern">Body Pattern</label>
          <input
            id="body-pattern"
            type="text"
            bind:value={formData.regexPatterns.body}
            class:error={errors.pattern_body}
            placeholder="e.g., (urgent|critical|asap)"
          />
          {#if errors.pattern_body}
            <span class="error-message">{errors.pattern_body}</span>
          {/if}
        </div>
      </div>

      <!-- AI Condition -->
      <div class="form-section">
        <h3>AI Condition</h3>
        <p class="section-description">
          Natural language condition evaluated by AI for flexible matching.
        </p>

        <div class="form-group">
          <label for="ai-condition">AI Condition</label>
          <textarea
            id="ai-condition"
            bind:value={formData.aiCondition}
            placeholder="e.g., Customer is reporting a bug or technical issue that needs immediate attention"
            rows="4"
          ></textarea>
        </div>
      </div>

      <!-- Advanced -->
      <div class="form-section">
        <h3>Advanced</h3>

        <div class="form-group">
          <label for="signal-type">Signal Type</label>
          <input
            id="signal-type"
            type="text"
            bind:value={formData.signalType}
            placeholder="message.email.{category}"
          />
          <span class="field-hint">
            Leave blank to auto-generate: message.email.{formData.category}
          </span>
        </div>
      </div>

      <!-- Pattern Tester -->
      <div class="form-section pattern-tester">
        <h3>Pattern Tester</h3>
        <p class="section-description">Test your regex patterns against sample email content.</p>

        <div class="tester-inputs">
          <div class="form-group">
            <label for="test-subject">Test Subject</label>
            <input
              id="test-subject"
              type="text"
              bind:value={testInput.subject}
              placeholder="Bug in the system"
            />
          </div>

          <div class="form-group">
            <label for="test-from">Test From</label>
            <input
              id="test-from"
              type="text"
              bind:value={testInput.from}
              placeholder="user@example.com"
            />
          </div>

          <div class="form-group">
            <label for="test-body">Test Body</label>
            <textarea
              id="test-body"
              bind:value={testInput.body}
              placeholder="I found a critical bug..."
              rows="3"
            ></textarea>
          </div>
        </div>

        <div class="tester-actions">
          <button type="button" class="btn-secondary" onclick={testPatterns}>Test Patterns</button>
          <button type="button" class="btn-secondary" onclick={clearTest}>Clear</button>
        </div>

        {#if Object.keys(testResults).length > 0}
          <div class="test-results">
            <h4>Results:</h4>
            {#each Object.entries(testResults) as [field, matches]}
              <div class="test-result" class:match={matches} class:no-match={!matches}>
                <span class="field-name">{field}:</span>
                <span class="match-status">{matches ? '✓ Matches' : '✗ No Match'}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    <div class="form-footer">
      <button type="button" class="btn-secondary" onclick={handleCancel}>Cancel</button>
      <button type="submit" class="btn-primary">
        {rule ? 'Update Rule' : 'Create Rule'}
      </button>
    </div>
  </form>
</div>

<style>
  .rule-form {
    width: 100%;
    max-width: 900px;
    margin: 0 auto;
  }

  form {
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .form-header {
    padding: 1.5rem;
    border-bottom: 1px solid #e0e0e0;
  }

  .form-header h2 {
    margin: 0;
    font-size: 1.5rem;
    color: #333;
  }

  .form-body {
    padding: 1.5rem;
  }

  .form-section {
    margin-bottom: 2rem;
    padding-bottom: 2rem;
    border-bottom: 1px solid #f0f0f0;
  }

  .form-section:last-child {
    border-bottom: none;
  }

  .form-section h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1.125rem;
    color: #333;
  }

  .section-description {
    margin: 0 0 1rem 0;
    font-size: 0.875rem;
    color: #666;
  }

  .form-group {
    margin-bottom: 1rem;
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: #333;
    font-size: 0.9rem;
  }

  .priority-hint {
    font-weight: normal;
    color: #666;
    font-size: 0.85rem;
  }

  input[type='text'],
  input[type='number'],
  select,
  textarea {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 0.9rem;
    font-family: inherit;
    transition: border-color 0.2s;
  }

  input[type='text']:focus,
  input[type='number']:focus,
  select:focus,
  textarea:focus {
    outline: none;
    border-color: #4a90e2;
  }

  input[type='text'].error,
  select.error,
  textarea.error {
    border-color: #e74c3c;
  }

  input[type='range'] {
    width: 100%;
    height: 6px;
    -webkit-appearance: none;
    appearance: none;
    background: #ddd;
    border-radius: 3px;
    outline: none;
  }

  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 18px;
    height: 18px;
    background: #4a90e2;
    border-radius: 50%;
    cursor: pointer;
  }

  input[type='range']::-moz-range-thumb {
    width: 18px;
    height: 18px;
    background: #4a90e2;
    border-radius: 50%;
    cursor: pointer;
    border: none;
  }

  input[type='checkbox'] {
    margin-right: 0.5rem;
  }

  .field-hint {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.8rem;
    color: #666;
  }

  .error-message {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.85rem;
    color: #e74c3c;
  }

  .error-message.global {
    padding: 0.75rem;
    background: #fee;
    border-left: 3px solid #e74c3c;
    border-radius: 4px;
    margin-bottom: 1rem;
  }

  .pattern-tester {
    background: #f9f9f9;
    padding: 1.5rem;
    border-radius: 8px;
    border: 1px solid #e0e0e0;
  }

  .tester-inputs {
    margin-bottom: 1rem;
  }

  .tester-actions {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .test-results {
    margin-top: 1rem;
    padding: 1rem;
    background: white;
    border-radius: 4px;
    border: 1px solid #ddd;
  }

  .test-results h4 {
    margin: 0 0 0.75rem 0;
    font-size: 0.9rem;
    color: #333;
  }

  .test-result {
    display: flex;
    justify-content: space-between;
    padding: 0.5rem;
    margin-bottom: 0.25rem;
    border-radius: 4px;
  }

  .test-result.match {
    background: #d4edda;
    border: 1px solid #c3e6cb;
  }

  .test-result.no-match {
    background: #f8d7da;
    border: 1px solid #f5c6cb;
  }

  .field-name {
    font-weight: 500;
    text-transform: capitalize;
  }

  .match-status {
    font-size: 0.9rem;
  }

  .form-footer {
    padding: 1.5rem;
    border-top: 1px solid #e0e0e0;
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
  }

  button {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 4px;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-primary {
    background: #4a90e2;
    color: white;
  }

  .btn-primary:hover {
    background: #357abd;
  }

  .btn-secondary {
    background: #f5f5f5;
    color: #333;
    border: 1px solid #ddd;
  }

  .btn-secondary:hover {
    background: #e0e0e0;
  }

  /* Responsive design */
  @media (max-width: 768px) {
    .form-row {
      grid-template-columns: 1fr;
    }

    .form-body,
    .form-header,
    .form-footer {
      padding: 1rem;
    }
  }
</style>
