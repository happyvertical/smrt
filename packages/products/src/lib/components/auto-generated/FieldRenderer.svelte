<script lang="ts">
/**
 * Automatic field renderer that maps TypeScript types to UI components
 * This demonstrates the "Define Once, Consume Everywhere" vision
 */

import { Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n.js';

const { t } = useI18n();

interface Props {
  fieldName: string;
  fieldType: 'string' | 'number' | 'boolean' | 'array' | 'object';
  value: unknown;
  label?: string;
  placeholder?: string;
  required?: boolean;
  readonly?: boolean;
  onUpdate?: (value: unknown) => void;
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
const displayLabel = $derived(
  label ||
    fieldName
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (str) => str.toUpperCase()),
);
const fieldId = $derived(`field-${fieldName}`);

function handleUpdate(newValue: unknown) {
  if (onUpdate && !readonly) {
    onUpdate(newValue);
  }
}

function handleStringInput(event: Event) {
  const target = event.target as HTMLInputElement;
  handleUpdate(target.value);
}

function handleNumberInput(event: Event) {
  const target = event.target as HTMLInputElement;
  handleUpdate(Number.parseFloat(target.value) || 0);
}

function handleBooleanInput(event: Event) {
  const target = event.target as HTMLInputElement;
  handleUpdate(target.checked);
}

function handleArrayInput(event: Event) {
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

function handleObjectInput(event: Event) {
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
    <Input
      id={fieldId}
      type="text"
      value={String(value ?? '')}
      {placeholder}
      {readonly}
      {required}
      oninput={handleStringInput}
    />
  {:else if fieldType === 'number'}
    <Input
      id={fieldId}
      type="number"
      value={typeof value === 'number' ? value : Number(value) || 0}
      {placeholder}
      {readonly}
      {required}
      oninput={handleNumberInput}
    />
  {:else if fieldType === 'boolean'}
    <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
    <input
      id={fieldId}
      type="checkbox"
      class="field-checkbox"
      checked={Boolean(value)}
      {readonly}
      onchange={handleBooleanInput}
    />
  {:else if fieldType === 'array'}
    <Textarea
      id={fieldId}
      value={Array.isArray(value) ? value.join(', ') : ''}
      placeholder={placeholder || 'Enter comma-separated values'}
      {readonly}
      {required}
      oninput={handleArrayInput}
    ></Textarea>
    <div class="field-hint">{t(M['products.field_renderer.array_hint'])}</div>
  {:else if fieldType === 'object'}
    <Textarea
      id={fieldId}
      value={typeof value === 'object' ? JSON.stringify(value, null, 2) : '{}'}
      placeholder={placeholder || 'Enter JSON object'}
      {readonly}
      {required}
      oninput={handleObjectInput}
    ></Textarea>
    <div class="field-hint">{t(M['products.field_renderer.object_hint'])}</div>
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
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface, #374151);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }

  .required {
    color: var(--smrt-color-error, #dc2626);
  }

  .field-checkbox {
    width: 1rem;
    height: 1rem;
  }

  .field-hint {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant, #6b7280);
    font-style: italic;
  }
</style>