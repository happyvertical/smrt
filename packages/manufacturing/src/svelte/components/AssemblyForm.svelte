<script lang="ts">
/**
 * AssemblyForm — add an assembly, or edit one: name, description, category,
 * part reference, price, estimated labour, default operation and tags.
 * Presentational: it never persists. The host receives trimmed, checked
 * values in `onsubmit` and saves them through the Assembly REST route or
 * `AssemblyCollection`.
 *
 * The host passes the operations to choose from (the active ones). An
 * operation already set on the assembly that is retired, or no longer in the
 * list, stays visible as the current value, marked, and can be cleared.
 *
 * Field policy: a field named in `hiddenFields` is not rendered, and one in
 * `readonlyFields` is shown but not editable (a price a viewer may see but
 * not change). Neither is checked, and `onsubmit` carries its initial value
 * unchanged, so a host should save only fields the reader may write.
 */

import { Button } from '@happyvertical/smrt-ui';
import { Form, Input, Select, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import {
  type AssemblyFormField,
  type AssemblyFormInitial,
  type AssemblyFormInvalidField,
  type AssemblyFormValues,
  assemblyFormDraft,
  currencyExponent,
  keepProtectedFields,
  type OperationView,
  validateAssemblyForm,
} from '../types.js';

const { t } = useI18n();

export interface AssemblyFormProps {
  /** The assembly being edited; omit or pass null to add one. */
  assembly?: AssemblyFormInitial | null;
  /** Invoked with trimmed, checked values. The form never persists. */
  onsubmit: (values: AssemblyFormValues) => void;
  /** Invoked when the form is canceled; omit to hide the cancel button. */
  oncancel?: () => void;
  /** Blocks input and submission while the host saves. */
  loading?: boolean;
  /** Operations to choose a default from: the active ones, host-loaded. */
  operations?: readonly OperationView[];
  /** ISO 4217 currency of the price, named in its help text. */
  currency?: string;
  /** Fields the reader may not see: not rendered. */
  hiddenFields?: readonly AssemblyFormField[];
  /** Fields the reader may see but not change: rendered read-only. */
  readonlyFields?: readonly AssemblyFormField[];
}

const {
  assembly = null,
  onsubmit,
  oncancel,
  loading = false,
  operations = [],
  currency = 'USD',
  hiddenFields = [],
  readonlyFields = [],
}: AssemblyFormProps = $props();

const uid = $props.id();
const exponent = $derived(currencyExponent(currency));
const isNew = $derived(assembly === null);

function getInitialFormState() {
  const initialExponent = currencyExponent(currency);
  return {
    assembly,
    exponent: initialExponent,
    draft: assemblyFormDraft(assembly, initialExponent),
  };
}

const initialFormState = getInitialFormState();
let name = $state(initialFormState.draft.name);
let description = $state(initialFormState.draft.description);
let category = $state(initialFormState.draft.category);
let partReference = $state(initialFormState.draft.partReference);
let price = $state(initialFormState.draft.price);
let estimatedLabourMinutes = $state(
  initialFormState.draft.estimatedLabourMinutes,
);
let defaultOperationId = $state(initialFormState.draft.defaultOperationId);
let tags = $state(initialFormState.draft.tags);
let invalid = $state<AssemblyFormInvalidField[]>([]);
let appliedAssembly: AssemblyFormInitial | null = initialFormState.assembly;
let appliedExponent = initialFormState.exponent;

// Follow the host when it swaps the assembly being edited.
// Follow a change of currency: show the stored price in the new minor unit.
$effect(() => {
  if (appliedExponent === exponent) return;
  appliedExponent = exponent;
  price = assemblyFormDraft(assembly, exponent).price;
});

$effect(() => {
  if (appliedAssembly === assembly) return;
  appliedAssembly = assembly;
  const draft = assemblyFormDraft(assembly, exponent);
  name = draft.name;
  description = draft.description;
  category = draft.category;
  partReference = draft.partReference;
  price = draft.price;
  estimatedLabourMinutes = draft.estimatedLabourMinutes;
  defaultOperationId = draft.defaultOperationId;
  tags = draft.tags;
  invalid = [];
});

const shown = (field: AssemblyFormField) => !hiddenFields.includes(field);
const locked = (field: AssemblyFormField) =>
  loading || readonlyFields.includes(field);

// The operation set when the form opened, kept in the list even if retired.
const originalOperationId = $derived(assembly?.defaultOperationId ?? '');

function operationLabel(operation: OperationView): string {
  const label = operation.name
    ? `${operation.code} - ${operation.name}`
    : operation.code;
  return operation.isActive
    ? label
    : t(M['manufacturing.assembly_form.operation_retired'], { label });
}

const operationChoices = $derived.by(() => {
  const choices: { id: string; label: string }[] = operations
    .filter(
      (operation) => operation.isActive || operation.id === originalOperationId,
    )
    .map((operation) => ({
      id: operation.id,
      label: operationLabel(operation),
    }));
  if (
    originalOperationId &&
    !choices.some((c) => c.id === originalOperationId)
  ) {
    choices.push({
      id: originalOperationId,
      label: t(M['manufacturing.assembly_form.operation_unknown'], {
        id: originalOperationId,
      }),
    });
  }
  return choices;
});

function errorMessage(field: AssemblyFormInvalidField): string {
  switch (field) {
    case 'name':
      return t(M['manufacturing.assembly_form.error_name']);
    case 'price':
      return t(M['manufacturing.assembly_form.error_price']);
    default:
      return t(M['manufacturing.assembly_form.error_labour']);
  }
}

const errors = $derived(
  invalid.map((field) => ({ field, message: errorMessage(field) })),
);

function errorId(field: AssemblyFormInvalidField): string {
  return `${uid}-error-${field}`;
}

function describedBy(
  field: AssemblyFormInvalidField | null,
  hintId?: string,
): string | undefined {
  const ids = [
    hintId,
    field && invalid.includes(field) ? errorId(field) : undefined,
  ];
  return ids.filter(Boolean).join(' ') || undefined;
}

const policyProtected = $derived([...hiddenFields, ...readonlyFields]);

function handleSubmit() {
  const draft = {
    name,
    description,
    category,
    partReference,
    price,
    estimatedLabourMinutes,
    defaultOperationId,
    tags,
  };
  // A field the reader left as it was keeps its stored value exactly (a tag
  // with a comma, a price this form cannot express); the name is always checked.
  const initialDraft = assemblyFormDraft(assembly, exponent);
  const untouched = (Object.keys(draft) as AssemblyFormField[]).filter(
    (field) => field !== 'name' && draft[field] === initialDraft[field],
  );
  const protectedFields = [...policyProtected, ...untouched];
  const result = validateAssemblyForm(draft, policyProtected, exponent);
  const checked =
    result.ok || untouched.length === 0
      ? result
      : validateAssemblyForm(draft, protectedFields, exponent);
  if (!checked.ok) {
    invalid = checked.invalid;
    return;
  }
  invalid = [];
  onsubmit(keepProtectedFields(checked.values, assembly, protectedFields));
}
</script>

<div class="assembly-form-shell">
  <Form class="assembly-form" onsubmit={handleSubmit}>
    {#if shown('name')}
      <div class="field">
        <label for="{uid}-name">
          {t(M['manufacturing.assembly_form.name'])}<span class="required" aria-hidden="true">*</span>
        </label>
        <Input
          id="{uid}-name"
          name="name"
          type="text"
          bind:value={name}
          required
          readonly={readonlyFields.includes('name')}
          disabled={loading}
          aria-invalid={invalid.includes('name') ? 'true' : undefined}
          aria-describedby={describedBy('name')}
        />
      </div>
    {/if}

    {#if shown('description')}
      <div class="field">
        <label for="{uid}-description">{t(M['manufacturing.assembly_form.description'])}</label>
        <Textarea
          id="{uid}-description"
          name="description"
          bind:value={description}
          readonly={readonlyFields.includes('description')}
          disabled={loading}
        />
      </div>
    {/if}

    {#if shown('partReference')}
      <div class="field">
        <label for="{uid}-part-reference">{t(M['manufacturing.assembly_form.part_reference'])}</label>
        <Input
          id="{uid}-part-reference"
          name="partReference"
          type="text"
          bind:value={partReference}
          readonly={readonlyFields.includes('partReference')}
          disabled={loading}
          aria-describedby="{uid}-part-reference-hint"
        />
        <span class="hint" id="{uid}-part-reference-hint">
          {t(M['manufacturing.assembly_form.part_reference_help'])}
        </span>
      </div>
    {/if}

    {#if shown('category')}
      <div class="field">
        <label for="{uid}-category">{t(M['manufacturing.assembly_form.category'])}</label>
        <Input
          id="{uid}-category"
          name="category"
          type="text"
          bind:value={category}
          readonly={readonlyFields.includes('category')}
          disabled={loading}
        />
      </div>
    {/if}

    {#if shown('price')}
      <div class="field">
        <label for="{uid}-price">{t(M['manufacturing.assembly_form.price'])}</label>
        <Input
          id="{uid}-price"
          name="price"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          bind:value={price}
          readonly={readonlyFields.includes('price')}
          disabled={loading}
          aria-invalid={invalid.includes('price') ? 'true' : undefined}
          aria-describedby={describedBy('price', `${uid}-price-hint`)}
        />
        <span class="hint" id="{uid}-price-hint">
          {t(M['manufacturing.assembly_form.price_help'], { currency })}
        </span>
      </div>
    {/if}

    {#if shown('estimatedLabourMinutes')}
      <div class="field">
        <label for="{uid}-labour">{t(M['manufacturing.assembly_form.labour'])}</label>
        <Input
          id="{uid}-labour"
          name="estimatedLabourMinutes"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          bind:value={estimatedLabourMinutes}
          readonly={readonlyFields.includes('estimatedLabourMinutes')}
          disabled={loading}
          aria-invalid={invalid.includes('estimatedLabourMinutes') ? 'true' : undefined}
          aria-describedby={describedBy('estimatedLabourMinutes', `${uid}-labour-hint`)}
        />
        <span class="hint" id="{uid}-labour-hint">
          {t(M['manufacturing.assembly_form.labour_help'])}
        </span>
      </div>
    {/if}

    {#if shown('defaultOperationId')}
      <div class="field">
        <label for="{uid}-operation">{t(M['manufacturing.assembly_form.operation'])}</label>
        <Select
          id="{uid}-operation"
          name="defaultOperationId"
          bind:value={defaultOperationId}
          disabled={locked('defaultOperationId')}
          aria-describedby="{uid}-operation-hint"
        >
          <option value="">{t(M['manufacturing.assembly_form.operation_none'])}</option>
          {#each operationChoices as choice (choice.id)}
            <option value={choice.id}>{choice.label}</option>
          {/each}
        </Select>
        <span class="hint" id="{uid}-operation-hint">
          {t(M['manufacturing.assembly_form.operation_help'])}
        </span>
      </div>
    {/if}

    {#if shown('tags')}
      <div class="field">
        <label for="{uid}-tags">{t(M['manufacturing.assembly_form.tags'])}</label>
        <Input
          id="{uid}-tags"
          name="tags"
          type="text"
          autocomplete="off"
          bind:value={tags}
          readonly={readonlyFields.includes('tags')}
          disabled={loading}
          aria-describedby="{uid}-tags-hint"
        />
        <span class="hint" id="{uid}-tags-hint">
          {t(M['manufacturing.assembly_form.tags_help'])}
        </span>
      </div>
    {/if}

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
          {t(M['manufacturing.assembly_form.cancel'])}
        </Button>
      {/if}
      <Button variant="primary" type="submit" disabled={loading}>
        {#if loading}
          {t(M['manufacturing.assembly_form.saving'])}
        {:else if isNew}
          {t(M['manufacturing.assembly_form.submit_add'])}
        {:else}
          {t(M['manufacturing.assembly_form.submit_edit'])}
        {/if}
      </Button>
    </div>
  </Form>
</div>

<style>
  .assembly-form-shell :global(.assembly-form) {
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
