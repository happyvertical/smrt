<script lang="ts">
/**
 * EditForm - a create / edit form for any model, derived from its manifest
 * definition and resolved field policy (#3718).
 *
 * Policy behavior: basic-tier fields render up front and advanced-tier fields
 * sit behind an "Advanced fields" disclosure (opened automatically when one
 * has a problem); hidden fields and fields outside the policy never render;
 * policy labels, help and order win over the manifest; on create, resolved
 * policy defaults prefill the draft. System fields are never editable.
 *
 * The form is transport-neutral. `onsubmit` receives a payload already
 * converted to wire values (safe integers, integer minor units for money,
 * ISO datetimes, parsed JSON); throw to report a failed save, or return
 * `{ fieldErrors }` to attach server-side validation messages to fields.
 * Remount with `{#key}` when switching to another record.
 *
 * For the policy gear, usage telemetry and per-field renderer registry use
 * `ObjectForm` from `@happyvertical/smrt-fields/svelte` instead.
 */
import { Alert } from '@happyvertical/smrt-ui/feedback';
import {
  Checkbox,
  Form,
  FormActionBar,
  FormGroup,
  Input,
  Textarea,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { PageHeader } from '@happyvertical/smrt-ui/layout';
import { Button, Disclosure } from '@happyvertical/smrt-ui/ui';
import { untrack } from 'svelte';
import { M } from '../../i18n/strings.screens.js';
import {
  deriveScreenFields,
  groupScreenFields,
  screenSourceError,
  screenTitles,
} from './fields.js';
import type {
  EditFormProps,
  ScreenCollectionDefinition,
  ScreenDraft,
  ScreenField,
  ScreenFieldErrorCode,
  ScreenPolicy,
  ScreenRecord,
} from './types.js';
import {
  DEFAULT_SCREEN_CURRENCY,
  draftForCreate,
  draftFromRecord,
  parseDraft,
} from './values.js';

let {
  definition,
  policy = null,
  record,
  title,
  fields: include,
  currency = DEFAULT_SCREEN_CURRENCY,
  showHeader = true,
  submitting = false,
  fieldErrors = {},
  error = null,
  onsubmit,
  oncancel,
}: EditFormProps = $props();

const { t } = useI18n();

const isNew = $derived(record === undefined);
const titles = $derived(screenTitles(definition));
const sourceError = $derived(screenSourceError(definition, policy));
const heading = $derived(
  title ??
    t(M[isNew ? 'ui.screens.create_title' : 'ui.screens.edit_title'], {
      name: titles.singular.toLowerCase(),
    }),
);

const allFields = $derived(
  sourceError
    ? []
    : deriveScreenFields(definition, policy, { mode: 'edit', include }),
);
const basicFields = $derived(allFields.filter((f) => f.tier === 'basic'));
const advancedFields = $derived(allFields.filter((f) => f.tier === 'advanced'));

function initialDraft(): ScreenDraft {
  return record
    ? draftFromRecord(allFields, record, { currency })
    : draftForCreate(allFields, policy, { currency });
}

let draft = $state<ScreenDraft>(initialDraft());
let localErrors = $state<Record<string, ScreenFieldErrorCode>>({});
let hostErrors = $state<Record<string, string>>({});
let failed = $state(false);
let working = $state(false);
let advancedOpen = $state(false);

// Re-seed when the host swaps the record (or the field set) under a mounted
// form; typing never re-seeds because only the identity is tracked.
const sessionKey = $derived(
  `${definition.objectRef}:${record ? String(record[definition.idField ?? 'id']) : 'new'}:${allFields.map((f) => f.name).join(',')}`,
);
let appliedKey = untrack(() => sessionKey);
$effect(() => {
  const key = sessionKey;
  if (key === appliedKey) return;
  appliedKey = key;
  untrack(() => {
    draft = initialDraft();
    localErrors = {};
    hostErrors = {};
    failed = false;
  });
});

function text(name: string): string {
  const value = draft[name];
  return typeof value === 'string' ? value : '';
}

function setText(name: string, value: string | number | undefined): void {
  draft[name] = String(value ?? '');
}

function messageFor(field: ScreenField): string | undefined {
  const code = localErrors[field.name];
  if (code) return t(M[`ui.screens.error.${code}`]);
  return fieldErrors[field.name] ?? hostErrors[field.name];
}

const advancedHasProblem = $derived(
  advancedFields.some(
    (f) => localErrors[f.name] || fieldErrors[f.name] || hostErrors[f.name],
  ),
);

function hint(field: ScreenField): string | undefined {
  return field.help ?? undefined;
}

function label(field: ScreenField): string {
  return field.kind === 'money' ? `${field.label} (${currency})` : field.label;
}

async function submit(): Promise<void> {
  if (working || submitting) return;
  failed = false;
  hostErrors = {};
  const parsed = parseDraft(allFields, draft, { currency });
  localErrors = parsed.errors;
  if (Object.keys(parsed.errors).length > 0) {
    if (advancedFields.some((f) => parsed.errors[f.name])) advancedOpen = true;
    return;
  }
  working = true;
  try {
    const result = await onsubmit(parsed.values, { isNew });
    if (result?.fieldErrors) {
      hostErrors = { ...result.fieldErrors };
      if (advancedFields.some((f) => result.fieldErrors?.[f.name])) {
        advancedOpen = true;
      }
    }
  } catch {
    failed = true;
  } finally {
    working = false;
  }
}

const busy = $derived(working || submitting);
const formError = $derived(
  error ?? (failed ? t(M['ui.screens.save_failed']) : null),
);
</script>

{#snippet control(field: ScreenField)}
  {#if field.kind === 'boolean'}
    <div class="smrt-edit-form__check">
      <Checkbox
        name={field.name}
        label={field.label}
        disabled={busy}
        bind:checked={() => draft[field.name] === true, (v) => (draft[field.name] = v)}
      />
      {#if field.help}
        <small class="smrt-edit-form__hint">{field.help}</small>
      {/if}
      {#if messageFor(field)}
        <small class="smrt-edit-form__error" role="alert">{messageFor(field)}</small>
      {/if}
    </div>
  {:else}
    <FormGroup
      label={label(field)}
      hint={hint(field)}
      error={messageFor(field)}
      required={field.required}
    >
      {#if field.kind === 'textarea' || field.kind === 'json'}
        <Textarea
          name={field.name}
          rows={field.kind === 'json' ? 8 : 4}
          disabled={busy}
          required={field.required}
          bind:value={() => text(field.name), (v) => setText(field.name, v)}
        />
      {:else}
        <Input
          name={field.name}
          type={field.kind === 'email'
            ? 'email'
            : field.kind === 'url'
              ? 'url'
              : field.kind === 'tel'
                ? 'tel'
                : field.kind === 'integer' || field.kind === 'decimal'
                  ? 'number'
                  : field.kind === 'datetime'
                    ? 'datetime-local'
                    : 'text'}
          step={field.kind === 'integer' ? '1' : field.kind === 'decimal' ? 'any' : undefined}
          inputmode={field.kind === 'money' ? 'decimal' : undefined}
          disabled={busy}
          required={field.required}
          bind:value={() => text(field.name), (v) => setText(field.name, v)}
        />
      {/if}
    </FormGroup>
  {/if}
{/snippet}

{#snippet fieldList(list: ScreenField[])}
  {#each groupScreenFields(list) as [group, groupFields] (group ?? '')}
    <fieldset class="smrt-edit-form__group">
      {#if group}<legend>{group}</legend>{/if}
      {#each groupFields as field (field.name)}
        {@render control(field)}
      {/each}
    </fieldset>
  {/each}
{/snippet}

{#if showHeader}
  <PageHeader title={heading} />
{/if}

<section class="smrt-edit-form" aria-label={heading}>
  {#if sourceError}
    <Alert variant="error">{sourceError}</Alert>
  {:else}
    <Form onsubmit={submit} novalidate>
      {#if formError}
        <Alert variant="error">{formError}</Alert>
      {/if}
      {@render fieldList(basicFields)}
      {#if advancedFields.length > 0}
        <Disclosure
          title={t(M['ui.screens.advanced_fields'])}
          bind:open={() => advancedOpen || advancedHasProblem, (v) => (advancedOpen = v)}
        >
          {@render fieldList(advancedFields)}
        </Disclosure>
      {/if}
      <FormActionBar>
        {#if oncancel}
          <Button type="button" variant="ghost" disabled={busy} onclick={oncancel}>
            {t(M['ui.screens.cancel'])}
          </Button>
        {/if}
        <Button type="submit" variant="primary" loading={busy} disabled={busy}>
          {t(M['ui.screens.save'])}
        </Button>
      </FormActionBar>
    </Form>
  {/if}
</section>

<style>
  .smrt-edit-form {
    max-width: 40rem;
  }
  .smrt-edit-form__group {
    border: 0;
    margin: 0 0 var(--smrt-spacing-md, 1rem);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-md, 1rem);
  }
  .smrt-edit-form__group legend {
    font-weight: var(--smrt-typography-weight-semibold, 600);
    margin-bottom: var(--smrt-spacing-sm, 0.5rem);
  }
  .smrt-edit-form__check {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-xs, 0.25rem);
  }
  .smrt-edit-form__hint {
    color: var(--smrt-color-on-surface-variant, #5f6368);
  }
  .smrt-edit-form__error {
    color: var(--smrt-color-error, #b42318);
  }
</style>
