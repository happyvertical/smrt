<script lang="ts">
/**
 * Automatic field renderer that maps TypeScript types to UI components
 * This demonstrates the "Define Once, Consume Everywhere" vision
 */

interface Props {
  fieldName: string;
  fieldType: 'string' | 'number' | 'boolean' | 'array' | 'object';
  value: any;
  label?: string;
  placeholder?: string;
  required?: boolean;
  readonly?: boolean;
  onUpdate?: (value: any) => void;
}

const {
  fieldName,
  fieldType,
  value = '',
  label,
  placeholder,
  required = false,
  readonly = false,
  onUpdate,
}: Props = $props();

// Auto-generate label from field name if not provided
const _displayLabel =
  label ||
  fieldName
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (str) => str.toUpperCase());
const _fieldId = `field-${fieldName}`;

function handleUpdate(newValue: any) {
  if (onUpdate && !readonly) {
    onUpdate(newValue);
  }
}

function _handleStringInput(event: Event) {
  const target = event.target as HTMLInputElement;
  handleUpdate(target.value);
}

function _handleNumberInput(event: Event) {
  const target = event.target as HTMLInputElement;
  handleUpdate(Number.parseFloat(target.value) || 0);
}

function _handleBooleanInput(event: Event) {
  const target = event.target as HTMLInputElement;
  handleUpdate(target.checked);
}

function _handleArrayInput(event: Event) {
  const target = event.target as HTMLTextAreaElement;
  try {
    // Simple array handling - comma separated values
    const arrayValue = target.value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s);
    handleUpdate(arrayValue);
  } catch {
    // Keep current value on parse error
  }
}

function _handleObjectInput(event: Event) {
  const target = event.target as HTMLTextAreaElement;
  try {
    const objectValue = JSON.parse(target.value);
    handleUpdate(objectValue);
  } catch {
    // Keep current value on parse error
  }
}
</script>

<div class="field-renderer">
  <label for={fieldId} class="field-label">
    {displayLabel}
    {#if required}<span class="required">*</span>{/if}
  </label>

  {#if fieldType === 'string'}
    <input
      id={fieldId}
      type="text"
      class="field-input"
      {value}
      {placeholder}
      {readonly}
      {required}
      oninput={handleStringInput}
    />
  {:else if fieldType === 'number'}
    <input
      id={fieldId}
      type="number"
      class="field-input"
      value={value || 0}
      {placeholder}
      {readonly}
      {required}
      oninput={handleNumberInput}
    />
  {:else if fieldType === 'boolean'}
    <input
      id={fieldId}
      type="checkbox"
      class="field-checkbox"
      checked={value || false}
      {readonly}
      onchange={handleBooleanInput}
    />
  {:else if fieldType === 'array'}
    <textarea
      id={fieldId}
      class="field-textarea"
      value={Array.isArray(value) ? value.join(', ') : ''}
      placeholder={placeholder || 'Enter comma-separated values'}
      {readonly}
      {required}
      oninput={handleArrayInput}
    />
    <div class="field-hint">Enter values separated by commas</div>
  {:else if fieldType === 'object'}
    <textarea
      id={fieldId}
      class="field-textarea"
      value={typeof value === 'object' ? JSON.stringify(value, null, 2) : '{}'}
      placeholder={placeholder || 'Enter JSON object'}
      {readonly}
      {required}
      oninput={handleObjectInput}
    />
    <div class="field-hint">Enter valid JSON</div>
  {/if}
</div>

<style>
  .field-renderer {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .field-label {
    font-weight: 500;
    color: #374151;
    font-size: 0.875rem;
  }

  .required {
    color: #dc2626;
  }

  .field-input,
  .field-textarea {
    padding: 0.5rem 0.75rem;
    border: 1px solid #d1d5db;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .field-input:focus,
  .field-textarea:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  .field-textarea {
    min-height: 4rem;
    resize: vertical;
  }

  .field-checkbox {
    width: 1rem;
    height: 1rem;
  }

  .field-hint {
    font-size: 0.75rem;
    color: #6b7280;
    font-style: italic;
  }

  .field-input:read-only,
  .field-textarea:read-only {
    background-color: #f9fafb;
    cursor: not-allowed;
  }
</style>