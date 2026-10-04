<script lang="ts">
/**
 * OperationForm — add an operation, or edit one: code (new only), name,
 * category and an optional required-qualification id. Presentational: it never
 * persists. The host receives trimmed, checked values in `onsubmit` and calls
 * `OperationService.define` for a new operation, or `rename` and `update` for
 * an edit. The code is read-only when editing.
 */

import { Button } from '@happyvertical/smrt-ui';
import { Form, Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import {
  type OperationFormField,
  type OperationFormInitial,
  type OperationFormValues,
  validateOperationForm,
} from '../types.js';

const { t } = useI18n();

export interface OperationFormProps {
  /** The operation being edited; omit or pass null to add one. */
  operation?: OperationFormInitial | null;
  /** Invoked with trimmed, checked values. The form never persists. */
  onsubmit: (values: OperationFormValues) => void;
  /** Invoked when the form is canceled; omit to hide the cancel button. */
  oncancel?: () => void;
  /** Blocks input and submission while the host saves. */
  loading?: boolean;
  /** Categories offered as suggestions; other values are still accepted. */
  categories?: readonly string[];
}

const {
  operation = null,
  onsubmit,
  oncancel,
  loading = false,
  categories = [],
}: OperationFormProps = $props();

const uid = $props.id();
const isNew = $derived(operation === null);

function getInitialFormState() {
  return { operation };
}

const initialFormState = getInitialFormState();
let code = $state(initialFormState.operation?.code ?? '');
let name = $state(initialFormState.operation?.name ?? '');
let category = $state(initialFormState.operation?.category ?? '');
let requiredQualificationId = $state(
  initialFormState.operation?.requiredQualificationId ?? '',
);
let invalid = $state<OperationFormField[]>([]);
let appliedOperation: OperationFormInitial | null = initialFormState.operation;

// Follow the host when it swaps the operation being edited.
$effect(() => {
  if (appliedOperation === operation) return;
  appliedOperation = operation;
  code = operation?.code ?? '';
  name = operation?.name ?? '';
  category = operation?.category ?? '';
  requiredQualificationId = operation?.requiredQualificationId ?? '';
  invalid = [];
});

function errorMessage(field: OperationFormField): string {
  return field === 'code'
    ? t(M['manufacturing.operation_form.error_code'])
    : t(M['manufacturing.operation_form.error_name']);
}

const errors = $derived(
  invalid.map((field) => ({ field, message: errorMessage(field) })),
);

function errorId(field: OperationFormField): string {
  return `${uid}-error-${field}`;
}

function describedBy(
  field: OperationFormField,
  hintId?: string,
): string | undefined {
  const ids = [hintId, invalid.includes(field) ? errorId(field) : undefined];
  return ids.filter(Boolean).join(' ') || undefined;
}

function handleSubmit() {
  const result = validateOperationForm({
    code,
    name,
    category,
    requiredQualificationId,
  });
  if (!result.ok) {
    invalid = result.invalid;
    return;
  }
  invalid = [];
  onsubmit(result.values);
}
</script>

<div class="operation-form-shell">
  <Form class="operation-form" onsubmit={handleSubmit}>
    <div class="field">
      <label for="{uid}-code">
        {t(M['manufacturing.operation_form.code'])}<span class="required" aria-hidden="true">*</span>
      </label>
      <Input
        id="{uid}-code"
        name="code"
        type="text"
        bind:value={code}
        required
        readonly={!isNew}
        disabled={loading}
        aria-invalid={invalid.includes('code') ? 'true' : undefined}
        aria-describedby={describedBy('code', isNew ? undefined : `${uid}-code-hint`)}
      />
      {#if !isNew}
        <span class="hint" id="{uid}-code-hint">
          {t(M['manufacturing.operation_form.code_edit_help'])}
        </span>
      {/if}
    </div>

    <div class="field">
      <label for="{uid}-name">
        {t(M['manufacturing.operation_form.name'])}<span class="required" aria-hidden="true">*</span>
      </label>
      <Input
        id="{uid}-name"
        name="name"
        type="text"
        bind:value={name}
        required
        disabled={loading}
        aria-invalid={invalid.includes('name') ? 'true' : undefined}
        aria-describedby={describedBy('name')}
      />
    </div>

    <div class="field">
      <label for="{uid}-category">{t(M['manufacturing.operation_form.category'])}</label>
      <Input
        id="{uid}-category"
        name="category"
        type="text"
        list="{uid}-categories"
        autocomplete="off"
        bind:value={category}
        disabled={loading}
        aria-describedby="{uid}-category-hint"
      />
      <datalist id="{uid}-categories">
        {#each categories as suggestion (suggestion)}
          <option value={suggestion}></option>
        {/each}
      </datalist>
      <span class="hint" id="{uid}-category-hint">
        {t(M['manufacturing.operation_form.category_help'])}
      </span>
    </div>

    <div class="field">
      <label for="{uid}-qualification">{t(M['manufacturing.operation_form.qualification'])}</label>
      <Input
        id="{uid}-qualification"
        name="requiredQualificationId"
        type="text"
        bind:value={requiredQualificationId}
        disabled={loading}
        aria-describedby="{uid}-qualification-hint"
      />
      <span class="hint" id="{uid}-qualification-hint">
        {t(M['manufacturing.operation_form.qualification_help'])}
      </span>
    </div>

    {#if errors.length > 0}
      <div class="errors" role="alert">
        <ul>
          {#each errors as error (error.field)}
            <li id={errorId(error.field)}>{error.message}</li>
          {/each}
        </ul>
      </div>
    {/if}

    <div class="actions">
      {#if oncancel}
        <Button variant="secondary" type="button" onclick={oncancel} disabled={loading}>
          {t(M['manufacturing.operation_form.cancel'])}
        </Button>
      {/if}
      <Button variant="primary" type="submit" disabled={loading}>
        {#if loading}
          {t(M['manufacturing.operation_form.saving'])}
        {:else if isNew}
          {t(M['manufacturing.operation_form.submit_add'])}
        {:else}
          {t(M['manufacturing.operation_form.submit_edit'])}
        {/if}
      </Button>
    </div>
  </Form>
</div>

<style>
  .operation-form-shell :global(.operation-form) {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-md, 1rem);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  label {
    font: var(--smrt-typography-body-medium-font, 500 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .required {
    color: var(--smrt-color-error, inherit);
  }

  .hint {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .errors {
    color: var(--smrt-color-error, inherit);
  }

  .errors ul {
    margin: 0;
    padding-left: 1.25rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--smrt-spacing-sm, 0.5rem);
    margin-top: var(--smrt-spacing-sm, 0.5rem);
  }
</style>
