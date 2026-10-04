<script lang="ts">
/**
 * EmployeeForm — the fields a host edits when hiring or editing an employee:
 * employee number, worker type, position, start date (new hire only),
 * effective date (edit only) and an optional login link. Presentational: it
 * never persists. The host receives trimmed, checked values in `onsubmit` and
 * calls `EmploymentService`: `hire` for a new hire, or, for an edit,
 * `changePosition` / `changeWorkerType` / `linkLogin` / `unlinkLogin` for
 * each value that changed, dated with the returned `effectiveOn`.
 *
 * The person is chosen by the host before the form opens: HR holds no
 * identity data, so there is no name field here.
 */

import { Button } from '@happyvertical/smrt-ui';
import { Form, Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { type IsoDate, SUGGESTED_WORKER_TYPES } from '../../types.js';
import { M } from '../i18n.js';
import {
  type EmployeeFormDraft,
  type EmployeeFormField,
  type EmployeeFormInitial,
  type EmployeeFormValues,
  type EmployeeLoginOption,
  validateEmployeeForm,
} from '../types.js';

const { t } = useI18n();

export interface EmployeeFormProps {
  /** The employment being edited; omit or pass null to hire. */
  employee?: EmployeeFormInitial | null;
  /** Invoked with trimmed, checked values. The form never persists. */
  onsubmit: (values: EmployeeFormValues) => void;
  /** Invoked when the form is canceled; omit to hide the cancel button. */
  oncancel?: () => void;
  /** Blocks input and submission while the host saves. */
  loading?: boolean;
  /** Worker types offered as suggestions; other values are still accepted. */
  workerTypes?: readonly string[];
  /**
   * Logins the host offers. With options the login field is a choice;
   * without, it takes a `smrt-users:User` id.
   */
  logins?: readonly EmployeeLoginOption[];
  /**
   * The host's local date, prefilled as a new hire's start date and as an
   * edit's effective date.
   */
  today?: IsoDate;
}

const {
  employee = null,
  onsubmit,
  oncancel,
  loading = false,
  workerTypes = SUGGESTED_WORKER_TYPES,
  logins,
  today,
}: EmployeeFormProps = $props();

const uid = $props.id();
const isNew = $derived(employee === null);

function draftFor(from: EmployeeFormInitial | null): EmployeeFormDraft {
  return {
    employeeNumber: from?.employeeNumber ?? '',
    workerType: from?.workerType ?? 'employee',
    position: from?.position ?? '',
    userId: from?.userId ?? '',
    startedOn: from ? '' : (today ?? ''),
    effectiveOn: from ? (today ?? '') : '',
  };
}

function getInitialFormState() {
  return { employee, draft: draftFor(employee) };
}

const initialFormState = getInitialFormState();
let employeeNumber = $state(initialFormState.draft.employeeNumber);
let workerType = $state(initialFormState.draft.workerType);
let position = $state(initialFormState.draft.position);
let userId = $state(initialFormState.draft.userId);
let startedOn = $state(initialFormState.draft.startedOn);
let effectiveOn = $state(initialFormState.draft.effectiveOn);
let invalid = $state<EmployeeFormField[]>([]);
let appliedEmployee: EmployeeFormInitial | null = initialFormState.employee;

// Follow the host when it swaps the employment being edited.
$effect(() => {
  if (appliedEmployee === employee) return;
  appliedEmployee = employee;
  const draft = draftFor(employee);
  employeeNumber = draft.employeeNumber;
  workerType = draft.workerType;
  position = draft.position;
  userId = draft.userId;
  startedOn = draft.startedOn;
  effectiveOn = draft.effectiveOn;
  invalid = [];
});

function errorMessage(field: EmployeeFormField): string {
  switch (field) {
    case 'employeeNumber':
      return t(M['human_resources.employee_form.error_employee_number']);
    case 'workerType':
      return t(M['human_resources.employee_form.error_worker_type']);
    case 'effectiveOn':
      return t(M['human_resources.employee_form.error_effective_on']);
    default:
      return t(M['human_resources.employee_form.error_started_on']);
  }
}

const errors = $derived(
  invalid.map((field) => ({ field, message: errorMessage(field) })),
);

/** The id of a field's validation message, as rendered in the error list. */
function errorId(field: EmployeeFormField): string {
  return `${uid}-error-${field}`;
}

/**
 * `aria-describedby` for a field: its hint, plus its validation message
 * while it is invalid.
 */
function describedBy(
  field: EmployeeFormField,
  hintId?: string,
): string | undefined {
  const ids = [hintId, invalid.includes(field) ? errorId(field) : undefined];
  return ids.filter(Boolean).join(' ') || undefined;
}

// The employee's current login stays selectable even when the host's options
// leave it out, so submitting an unrelated edit never unlinks it.
const loginOptions = $derived.by((): EmployeeLoginOption[] | undefined => {
  if (!logins) return undefined;
  const current = employee?.userId;
  if (!current || logins.some((login) => login.value === current))
    return [...logins];
  return [
    {
      value: current,
      label: t(M['human_resources.employee_form.login_current'], {
        id: current,
      }),
    },
    ...logins,
  ];
});

function handleSubmit() {
  const result = validateEmployeeForm(
    { employeeNumber, workerType, position, userId, startedOn, effectiveOn },
    isNew,
  );
  if (!result.ok) {
    invalid = result.invalid;
    return;
  }
  invalid = [];
  onsubmit(result.values);
}
</script>

<div class="employee-form-shell">
  <Form class="employee-form" onsubmit={handleSubmit}>
    <div class="field">
      <label for="{uid}-employee-number">
        {t(M['human_resources.employee_form.employee_number'])}<span class="required" aria-hidden="true">*</span>
      </label>
      <Input
        id="{uid}-employee-number"
        name="employeeNumber"
        type="text"
        bind:value={employeeNumber}
        required
        readonly={!isNew}
        disabled={loading}
        aria-invalid={invalid.includes('employeeNumber') ? 'true' : undefined}
        aria-describedby={describedBy(
          'employeeNumber',
          isNew ? undefined : `${uid}-employee-number-hint`,
        )}
      />
      {#if !isNew}
        <span class="hint" id="{uid}-employee-number-hint">
          {t(M['human_resources.employee_form.employee_number_edit_help'])}
        </span>
      {/if}
    </div>

    <div class="field">
      <label for="{uid}-worker-type">
        {t(M['human_resources.employee_form.worker_type'])}<span class="required" aria-hidden="true">*</span>
      </label>
      <Input
        id="{uid}-worker-type"
        name="workerType"
        type="text"
        list="{uid}-worker-types"
        autocomplete="off"
        bind:value={workerType}
        required
        disabled={loading}
        aria-invalid={invalid.includes('workerType') ? 'true' : undefined}
        aria-describedby={describedBy('workerType', `${uid}-worker-type-hint`)}
      />
      <datalist id="{uid}-worker-types">
        {#each workerTypes as suggestion (suggestion)}
          <option value={suggestion}></option>
        {/each}
      </datalist>
      <span class="hint" id="{uid}-worker-type-hint">
        {t(M['human_resources.employee_form.worker_type_help'])}
      </span>
    </div>

    <div class="field">
      <label for="{uid}-position">{t(M['human_resources.employee_form.position'])}</label>
      <Input id="{uid}-position" name="position" type="text" bind:value={position} disabled={loading} />
    </div>

    {#if isNew}
      <div class="field">
        <label for="{uid}-started-on">
          {t(M['human_resources.employee_form.started_on'])}<span class="required" aria-hidden="true">*</span>
        </label>
        <Input
          id="{uid}-started-on"
          name="startedOn"
          type="date"
          bind:value={startedOn}
          required
          disabled={loading}
          aria-invalid={invalid.includes('startedOn') ? 'true' : undefined}
          aria-describedby={describedBy('startedOn')}
        />
      </div>
    {:else}
      <div class="field">
        <label for="{uid}-effective-on">
          {t(M['human_resources.employee_form.effective_on'])}<span class="required" aria-hidden="true">*</span>
        </label>
        <Input
          id="{uid}-effective-on"
          name="effectiveOn"
          type="date"
          bind:value={effectiveOn}
          required
          disabled={loading}
          aria-invalid={invalid.includes('effectiveOn') ? 'true' : undefined}
          aria-describedby={describedBy('effectiveOn', `${uid}-effective-on-hint`)}
        />
        <span class="hint" id="{uid}-effective-on-hint">
          {t(M['human_resources.employee_form.effective_on_help'])}
        </span>
      </div>
    {/if}

    <div class="field">
      <label for="{uid}-login">{t(M['human_resources.employee_form.login'])}</label>
      {#if loginOptions}
        <Select
          id="{uid}-login"
          name="userId"
          bind:value={userId}
          disabled={loading}
          aria-describedby="{uid}-login-hint"
        >
          <option value="">{t(M['human_resources.employee_form.login_none'])}</option>
          {#each loginOptions as login (login.value)}
            <option value={login.value}>{login.label}</option>
          {/each}
        </Select>
      {:else}
        <Input
          id="{uid}-login"
          name="userId"
          type="text"
          bind:value={userId}
          disabled={loading}
          aria-describedby="{uid}-login-hint"
        />
      {/if}
      <span class="hint" id="{uid}-login-hint">
        {t(M['human_resources.employee_form.login_help'])}
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
          {t(M['human_resources.employee_form.cancel'])}
        </Button>
      {/if}
      <Button variant="primary" type="submit" disabled={loading}>
        {#if loading}
          {t(M['human_resources.employee_form.saving'])}
        {:else if isNew}
          {t(M['human_resources.employee_form.submit_hire'])}
        {:else}
          {t(M['human_resources.employee_form.submit_edit'])}
        {/if}
      </Button>
    </div>
  </Form>
</div>

<style>
  .employee-form-shell :global(.employee-form) {
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
