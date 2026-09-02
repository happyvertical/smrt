<script lang="ts">
import { Form, Input, Select, Textarea } from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { AgentSettingsSchema } from '../../ui.js';

export interface Props {
  /** Current configuration values. */
  config: Record<string, unknown>;
  /** Schema defining the form fields and their constraints. */
  schema: AgentSettingsSchema;
  /** Fired when the user submits the form with updated values. */
  onSave?: (config: Record<string, unknown>) => Promise<void>;
  /** Disables all inputs and hides the save button when true. */
  readonly?: boolean;
}

let { config, schema, onSave, readonly = false }: Props = $props();

let draft = $state<Record<string, string | boolean>>({});
let errors = $state<Record<string, string>>({});
let saving = $state(false);
let appliedConfig: Record<string, unknown> | undefined;

function displayValue(value: unknown, type: string): string | boolean {
  if (type === 'boolean') return Boolean(value);
  if (type === 'json' && value !== undefined) {
    return JSON.stringify(value, null, 2);
  }
  return value === undefined || value === null ? '' : String(value);
}

$effect(() => {
  if (appliedConfig === config) return;
  appliedConfig = config;
  draft = Object.fromEntries(
    schema.fields.map((field) => [
      field.id,
      displayValue(config[field.id] ?? field.default, field.type),
    ]),
  );
  errors = {};
});

function setText(id: string, event: Event) {
  draft[id] = (event.currentTarget as HTMLInputElement).value;
}

function setBoolean(id: string, event: Event) {
  draft[id] = (event.currentTarget as HTMLInputElement).checked;
}

async function handleSubmit() {
  const next: Record<string, unknown> = { ...config };
  const nextErrors: Record<string, string> = {};

  for (const field of schema.fields) {
    const value = draft[field.id];
    if (field.required && (value === '' || value === undefined)) {
      nextErrors[field.id] = `${field.label} is required`;
      continue;
    }

    if (field.type === 'number') {
      if (value === '') {
        delete next[field.id];
      } else {
        const numberValue = Number(value);
        if (!Number.isFinite(numberValue)) {
          nextErrors[field.id] = `${field.label} must be a number`;
        } else {
          next[field.id] = numberValue;
        }
      }
    } else if (field.type === 'json') {
      if (value === '') {
        delete next[field.id];
      } else {
        try {
          next[field.id] = JSON.parse(String(value));
        } catch {
          nextErrors[field.id] = `${field.label} must contain valid JSON`;
        }
      }
    } else if (field.type === 'boolean') {
      next[field.id] = Boolean(value);
    } else if (value === '') {
      delete next[field.id];
    } else {
      next[field.id] = value;
    }
  }

  errors = nextErrors;
  if (Object.keys(nextErrors).length > 0 || !onSave) return;

  saving = true;
  try {
    await onSave(next);
  } finally {
    saving = false;
  }
}
</script>

<Form class="agent-settings-form" onsubmit={handleSubmit}>
  {#each schema.fields as field (field.id)}
    <div class="field">
      {#if field.type === 'boolean'}
        <label class="checkbox" for={field.id}>
          <!-- raw-primitive-allow: native checkbox preserves checkbox semantics without requiring a Provider -->
          <input
            id={field.id}
            type="checkbox"
            checked={Boolean(draft[field.id])}
            onchange={(event) => setBoolean(field.id, event)}
            disabled={readonly || saving}
          />
          <span>{field.label}</span>
        </label>
      {:else}
        <label for={field.id}>{field.label}</label>
        {#if field.type === 'select'}
          <Select
            id={field.id}
            value={String(draft[field.id] ?? '')}
            onchange={(event) => setText(field.id, event)}
            required={field.required}
            disabled={readonly || saving}
          >
            <option value="">Select…</option>
            {#each field.options ?? [] as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </Select>
        {:else if field.type === 'textarea' || field.type === 'json'}
          <Textarea
            id={field.id}
            value={String(draft[field.id] ?? '')}
            oninput={(event) => setText(field.id, event)}
            placeholder={field.placeholder}
            required={field.required}
            disabled={readonly || saving}
            rows={field.type === 'json' ? 8 : 4}
          />
        {:else}
          <Input
            id={field.id}
            type={field.type === 'number' ? 'number' : 'text'}
            value={String(draft[field.id] ?? '')}
            oninput={(event) => setText(field.id, event)}
            placeholder={field.placeholder}
            required={field.required}
            min={field.min}
            max={field.max}
            disabled={readonly || saving}
          />
        {/if}
      {/if}
      {#if field.description}<small>{field.description}</small>{/if}
      {#if errors[field.id]}<p class="error">{errors[field.id]}</p>{/if}
    </div>
  {/each}

  {#if !readonly}
    <div class="actions">
      <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>
    </div>
  {/if}
</Form>

<style>
  :global(.agent-settings-form) {
    display: grid;
    gap: var(--smrt-spacing-5, 1.25rem);
  }

  .field {
    display: grid;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  label {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .checkbox {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  small {
    color: var(--smrt-color-on-surface-variant, #64748b);
  }

  .error {
    margin: 0;
    color: var(--smrt-color-error, #b91c1c);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    line-height: var(--smrt-typography-body-medium-line-height, 1.25rem);
    letter-spacing: var(--smrt-typography-body-medium-tracking, 0.015625rem);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
