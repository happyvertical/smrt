<script lang="ts">
/**
 * CreateRuleFromMessage - Create a routing rule based on message characteristics
 *
 * Features:
 * - Pre-populate rule from message analysis
 * - Extract patterns from email (subject, sender)
 * - Use AI-generated condition from message intent
 * - Suggest priority based on urgency
 * - One-click rule creation from processed message
 */

interface ProcessedMessage {
  id: string;
  emailId: string;
  intent: string;
  category: string;
  sentiment: string;
  urgency: string;
  senderEmail: string;
  senderName: string;
  entities: Record<string, any>;
}

interface Email {
  id: string;
  subject: string;
  fromAddress: string;
  fromName: string;
  textBody: string;
}

interface Props {
  message: ProcessedMessage;
  email: Email;
  onSave?: (rule: any) => void;
  onCancel?: () => void;
}

let { message, email, onSave, onCancel }: Props = $props();

// Extract patterns from email
function extractSubjectPattern(subject: string): string {
  // Extract key words (remove common stop words)
  const stopWords = [
    'the',
    'a',
    'an',
    'and',
    'or',
    'but',
    'in',
    'on',
    'at',
    'to',
    'for',
  ];
  const words = subject
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.includes(w))
    .slice(0, 3); // Take first 3 meaningful words

  return words.length > 0 ? `(${words.join('|')})` : '';
}

function extractFromPattern(fromAddress: string): string {
  // Extract domain from email
  const domain = fromAddress.split('@')[1];
  return domain ? `@${domain.replace(/\./g, '\\.')}` : '';
}

function suggestPriority(urgency: string): number {
  const priorityMap: Record<string, number> = {
    critical: 90,
    high: 75,
    medium: 50,
    low: 30,
  };
  return priorityMap[urgency] || 50;
}

function generateAICondition(message: ProcessedMessage): string {
  const parts: string[] = [];

  // Add intent
  if (message.intent) {
    parts.push(`Message intent is ${message.intent}`);
  }

  // Add sentiment if negative/angry
  if (message.sentiment === 'negative' || message.sentiment === 'angry') {
    parts.push('sender appears frustrated or unhappy');
  }

  // Add urgency
  if (message.urgency === 'critical' || message.urgency === 'high') {
    parts.push('requires urgent attention');
  }

  // Add entity context
  if (message.entities && Object.keys(message.entities).length > 0) {
    const entityTypes = Object.keys(message.entities).join(', ');
    parts.push(`mentions ${entityTypes}`);
  }

  return parts.join(' and ');
}

// Form state - pre-populated from message
let formData = $state({
  name: `${message.category.charAt(0).toUpperCase() + message.category.slice(1)} - ${message.intent}`,
  description: `Auto-generated rule based on message #${message.id.substring(0, 8)}`,
  enabled: false, // Start disabled for review
  priority: suggestPriority(message.urgency),
  category: message.category,
  signalType: `message.email.${message.category}`,
  regexPatterns: {
    subject: extractSubjectPattern(email.subject),
    from: extractFromPattern(email.fromAddress),
    body: '',
  },
  aiCondition: generateAICondition(message),
});

// Validation errors
let errors = $state<Record<string, string>>({});

// Categories
const categories = [
  { value: 'support', label: 'Support' },
  { value: 'sales', label: 'Sales' },
  { value: 'legal', label: 'Legal' },
  { value: 'ops', label: 'Operations' },
  { value: 'dev', label: 'Development' },
  { value: 'product', label: 'Product' },
  { value: 'content', label: 'Content' },
];

function validateForm(): boolean {
  const newErrors: Record<string, string> = {};

  if (!formData.name.trim()) {
    newErrors.name = 'Name is required';
  }

  if (!formData.category) {
    newErrors.category = 'Category is required';
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
    onSave?.(formData);
  }
}

function handleCancel() {
  onCancel?.();
}
</script>

<div class="create-rule">
  <div class="create-header">
    <h2>Create Rule from Message</h2>
    <p class="header-description">
      We've pre-populated this rule based on the message. Review and adjust as needed.
    </p>
  </div>

  <form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
    <div class="form-body">
      <!-- Source Message Info -->
      <div class="source-info">
        <h4>Source Message</h4>
        <div class="source-details">
          <div class="detail">
            <span class="detail-label">Subject:</span>
            <span class="detail-value">{email.subject}</span>
          </div>
          <div class="detail">
            <span class="detail-label">From:</span>
            <span class="detail-value">{email.fromAddress}</span>
          </div>
          <div class="detail">
            <span class="detail-label">Intent:</span>
            <span class="detail-value">{message.intent}</span>
          </div>
          <div class="detail">
            <span class="detail-label">Urgency:</span>
            <span class="detail-value">{message.urgency}</span>
          </div>
        </div>
      </div>

      <!-- Basic Info -->
      <div class="form-section">
        <h3>Rule Details</h3>

        <div class="form-group">
          <label for="name">Rule Name *</label>
          <input
            id="name"
            type="text"
            bind:value={formData.name}
            class:error={errors.name}
            placeholder="e.g., Support - Bug Reports"
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
            rows="2"
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
          </div>

          <div class="form-group">
            <label for="priority">Priority: {formData.priority}</label>
            <input
              id="priority"
              type="range"
              bind:value={formData.priority}
              min="0"
              max="100"
              step="5"
            />
            <span class="field-hint">Suggested based on message urgency</span>
          </div>
        </div>

        <div class="form-group">
          <label for="enabled">
            <input id="enabled" type="checkbox" bind:checked={formData.enabled} />
            Enable this rule immediately
          </label>
          <span class="field-hint">
            Leave unchecked to review and test before enabling
          </span>
        </div>
      </div>

      <!-- Patterns -->
      <div class="form-section">
        <h3>Matching Patterns</h3>
        <p class="section-description">
          These patterns were extracted from the source message. Adjust as needed.
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
            placeholder="(bug|error|issue)"
          />
          {#if errors.pattern_subject}
            <span class="error-message">{errors.pattern_subject}</span>
          {/if}
          <span class="field-hint">Extracted from: "{email.subject}"</span>
        </div>

        <div class="form-group">
          <label for="from-pattern">From Pattern</label>
          <input
            id="from-pattern"
            type="text"
            bind:value={formData.regexPatterns.from}
            class:error={errors.pattern_from}
            placeholder="@example\.com"
          />
          {#if errors.pattern_from}
            <span class="error-message">{errors.pattern_from}</span>
          {/if}
          <span class="field-hint">Extracted from: "{email.fromAddress}"</span>
        </div>

        <div class="form-group">
          <label for="body-pattern">Body Pattern (Optional)</label>
          <input
            id="body-pattern"
            type="text"
            bind:value={formData.regexPatterns.body}
            class:error={errors.pattern_body}
            placeholder="Add custom body pattern..."
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
          This condition was generated from the message analysis. Edit to refine.
        </p>

        <div class="form-group">
          <label for="ai-condition">AI Condition</label>
          <textarea
            id="ai-condition"
            bind:value={formData.aiCondition}
            placeholder="Natural language condition for AI evaluation..."
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
            Dispatch signal emitted when this rule matches
          </span>
        </div>
      </div>
    </div>

    <div class="form-footer">
      <button type="button" class="btn-secondary" onclick={handleCancel}>Cancel</button>
      <button type="submit" class="btn-primary">Create Rule</button>
    </div>
  </form>
</div>

<style>
  .create-rule {
    width: 100%;
    max-width: 900px;
    margin: 0 auto;
  }

  .create-header {
    margin-bottom: 1.5rem;
  }

  .create-header h2 {
    margin: 0 0 0.5rem 0;
    font-size: 1.5rem;
    color: #333;
  }

  .header-description {
    margin: 0;
    font-size: 0.9rem;
    color: #666;
  }

  form {
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .form-body {
    padding: 1.5rem;
  }

  .source-info {
    background: #f0f8ff;
    border: 1px solid #4a90e2;
    border-radius: 8px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }

  .source-info h4 {
    margin: 0 0 1rem 0;
    font-size: 0.95rem;
    color: #1565c0;
    font-weight: 600;
  }

  .source-details {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 0.75rem;
  }

  .detail {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .detail-label {
    font-weight: 600;
    color: #666;
    font-size: 0.8rem;
  }

  .detail-value {
    color: #333;
    font-size: 0.85rem;
    word-break: break-word;
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
  }

  input[type='text']:focus,
  select:focus,
  textarea:focus {
    outline: none;
    border-color: #4a90e2;
  }

  input.error {
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

    .source-details {
      grid-template-columns: 1fr;
    }
  }
</style>
