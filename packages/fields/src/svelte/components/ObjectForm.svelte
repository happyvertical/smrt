<script lang="ts">
/**
 * ObjectForm renders the safe intersection of a generated web definition and
 * its resolved field policy. It remains transport-neutral: callers own the
 * record and submission, while this component owns ordering, policy modes,
 * built-in wire-type adapters, and accessible field layout.
 */
import { Form } from '@happyvertical/smrt-ui/forms';
import type { Component, Snippet } from 'svelte';
import type { ResolvedObjectFieldPolicy } from '../../types.js';
import { tryGetFieldPolicyGearContext } from '../gear-context.svelte.js';
import type {
  FieldInputComponent,
  FieldInputRegistry,
} from '../input-registry.js';
import { resolveObjectFormFields } from '../object-form.js';
import { tryGetObjectFormSource } from '../object-form-source-context.svelte.js';
import {
  type FieldInputProps,
  type ObjectFormField,
  type ObjectFormFieldDefinition,
  type ObjectFormFieldSnippetProps,
} from '../types.js';
import {
  collectFieldUsageEntries,
  type FieldUsageReporter,
  reportFieldUsage,
} from '../usage-capture.js';
import AdvancedFields from './AdvancedFields.svelte';
import FieldInput from './FieldInput.svelte';
import FieldPolicyGearButton from './FieldPolicyGearButton.svelte';
import FieldPolicyProvider from './FieldPolicyProvider.svelte';
import ModeSwitch from './ModeSwitch.svelte';
import PolicyField from './PolicyField.svelte';

export interface ObjectFormProps {
  objectRef: string;
  /**
   * Generated browser-safe definitions — never pass raw server registry fields.
   * Omit with `policy` to resolve both through ObjectFormSourceProvider.
   */
  fields?: Readonly<Record<string, ObjectFormFieldDefinition>>;
  /** Pre-resolved policy for the same objectRef. Omit with `fields` for a source. */
  policy?: ResolvedObjectFieldPolicy;
  /** Mutable create/edit record. Bind this prop to retain values in the host. */
  value?: Record<string, unknown>;
  /** True for creates (defaults may prefill), false for loaded edits. */
  isNewRecord?: boolean;
  /**
   * Optional identity for a create session. Change this when reusing a mounted
   * form for another new record; defaults then apply once to missing values.
   * With no key, replacing the bound record with an empty object starts a new
   * create session automatically.
   */
  createSessionKey?: string | number;
  disabled?: boolean;
  showModeSwitch?: boolean;
  /** Render a provider-registered policy gear next to the mode control. */
  showPolicyGear?: boolean;
  inputRegistry?: FieldInputRegistry;
  /** Per-field custom widget snippets, keyed by field name. */
  renderers?: Readonly<Record<string, Snippet<[ObjectFormFieldSnippetProps]>>>;
  /** Optional controls rendered after the policy-ordered fields inside the form. */
  actions?: Snippet;
  /**
   * Optional telemetry transport. It runs only when `onsubmit` explicitly
   * resolves `true` after persistence; identity and field sensitivity remain
   * server-derived.
   */
  usageReporter?: FieldUsageReporter;
  class?: string;
  /** Return true only after the host has persisted this record successfully. */
  onsubmit?: ObjectFormSubmitHandler;
}

// biome-ignore lint/suspicious/noConfusingVoidType: void handlers remain a supported legacy integration and never acknowledge persistence.
export type ObjectFormSubmitAcknowledgement = boolean | void;
export type ObjectFormSubmitHandler = (
  event: SubmitEvent,
) => ObjectFormSubmitAcknowledgement | Promise<ObjectFormSubmitAcknowledgement>;

let {
  objectRef,
  fields = undefined,
  policy = undefined,
  value = $bindable<Record<string, unknown>>({}),
  isNewRecord = true,
  createSessionKey,
  disabled = false,
  showModeSwitch = true,
  showPolicyGear = false,
  inputRegistry,
  renderers = {},
  actions,
  usageReporter,
  class: className = '',
  onsubmit,
}: ObjectFormProps = $props();

const fieldPolicyGear = tryGetFieldPolicyGearContext();
const objectFormSource = tryGetObjectFormSource();
const formInstanceId = $props.id();
let invalidFields = $state<Set<string>>(new Set());

let sourceResult = $state<{
  fields: Readonly<Record<string, ObjectFormFieldDefinition>>;
  policy: ResolvedObjectFieldPolicy;
} | null>(null);
let sourceError = $state<string | null>(null);
let sourceLoading = $state(false);

// Direct props preserve SSR and existing integrations. The provider path makes
// an app's generated definitions + resolveBatch transport reusable across all
// objects without per-form glue.
$effect(() => {
  if (fields !== undefined || policy !== undefined) {
    sourceLoading = false;
    sourceResult = null;
    if (fields === undefined || policy === undefined) {
      sourceError =
        'ObjectForm requires both fields and policy when direct props are used.';
    } else if (policy.objectRef !== objectRef) {
      sourceError = `ObjectForm policy does not match '${objectRef}'.`;
    } else {
      sourceError = null;
    }
    return;
  }
  if (!objectFormSource) {
    sourceLoading = false;
    sourceResult = null;
    sourceError = `No ObjectForm source is available for '${objectRef}'.`;
    return;
  }

  let active = true;
  sourceLoading = true;
  sourceResult = null;
  sourceError = null;
  void objectFormSource
    .load(objectRef)
    .then((resolved) => {
      if (!active) return;
      if (
        resolved.definition.objectRef !== objectRef ||
        resolved.policy.objectRef !== objectRef
      ) {
        throw new Error(
          `ObjectForm source returned a mismatched objectRef for '${objectRef}'.`,
        );
      }
      sourceResult = {
        fields: resolved.definition.fields,
        policy: resolved.policy,
      };
    })
    .catch((error: unknown) => {
      if (active) {
        sourceError =
          error instanceof Error ? error.message : 'Unable to load this form.';
      }
    })
    .finally(() => {
      if (active) sourceLoading = false;
    });
  return () => {
    active = false;
  };
});

const resolvedFields = $derived(fields ?? sourceResult?.fields ?? {});
const resolvedPolicy = $derived(policy ?? sourceResult?.policy ?? null);

const formFields = $derived(
  resolvedPolicy ? resolveObjectFormFields(resolvedFields, resolvedPolicy) : [],
);
const basicGroups = $derived(groupFields('basic'));
const advancedGroups = $derived(groupFields('advanced'));

function groupFields(
  visibility: 'basic' | 'advanced',
): Array<[string | null, ObjectFormField[]]> {
  const result = new Map<string | null, ObjectFormField[]>();
  if (!resolvedPolicy) return [];
  for (const field of formFields) {
    if (resolvedPolicy.fields[field.name].visibility !== visibility) continue;
    const group = result.get(field.group) ?? [];
    group.push(field);
    result.set(field.group, group);
  }
  return [...result.entries()];
}

function setValue(name: string, next: unknown): void {
  const updated = { ...value, [name]: next };
  lastInternalValue = updated;
  lastObservedValue = updated;
  value = updated;
}

/** Generated fields need a stable accessible label even when policy omits one. */
function fieldLabel(field: ObjectFormField): string {
  return (
    resolvedPolicy?.fields[field.name].label ??
    field.name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[-_]+/g, ' ')
      .replace(/^./, (character) => character.toUpperCase())
  );
}

function setValidity(name: string, valid: boolean): void {
  const next = new Set(invalidFields);
  if (valid) next.delete(name);
  else next.add(name);
  invalidFields = next;
}

function fieldId(name: string): string {
  return `${formInstanceId}-${name}`;
}

function captureUsage(): void {
  if (!resolvedPolicy) return;
  reportFieldUsage(
    usageReporter,
    collectFieldUsageEntries({
      objectRef,
      values: value,
      // Hidden fields are not submitted user inputs. Basic and advanced fields
      // are included even when a value matches the default so the server's
      // dominance calculation has a complete denominator.
      fields: Object.fromEntries(
        formFields
          .filter(
            (field) =>
              resolvedPolicy.fields[field.name].visibility !== 'hidden',
          )
          .map((field) => [field.name, field.definition.type]),
      ),
      defaults: Object.fromEntries(
        formFields
          .filter(
            (field) =>
              resolvedPolicy.fields[field.name].visibility !== 'hidden',
          )
          .map((field) => {
            const resolved = resolvedPolicy.fields[field.name];
            return [
              field.name,
              {
                hasDefault: resolved.hasDefault,
                defaultValue: resolved.defaultValue,
              },
            ];
          }),
      ),
    }),
  );
}

async function handleSubmit(event: SubmitEvent): Promise<void> {
  if (invalidFields.size > 0) {
    event.preventDefault();
    return;
  }
  if (!onsubmit) return;
  try {
    // Form prevents native navigation itself, so persistence acknowledgement
    // must be explicit rather than inferred from event.defaultPrevented.
    if ((await onsubmit(event)) === true) captureUsage();
  } catch {
    // The host owns persistence errors; rejected submissions never emit usage.
  }
}

// Apply policy defaults to a create record once, before a user can interact
// with any control. This preserves JSON and boolean defaults (which cannot be
// faithfully inferred from generic DOM string assignment) and means callers
// receive a complete create payload. Loaded edit records never enter this path.
let initializedCreateSession = false;
let previousCreateSessionKey: string | number | undefined;
let previousIsNewRecord = false;
let lastObservedValue: Record<string, unknown> | undefined;
let lastInternalValue: Record<string, unknown> | undefined;

function isEmptyRecord(record: Record<string, unknown>): boolean {
  return Object.keys(record).length === 0;
}

$effect(() => {
  const currentValue = value;
  if (!resolvedPolicy || !isNewRecord) {
    previousIsNewRecord = isNewRecord;
    lastObservedValue = currentValue;
    return;
  }

  const explicitNewSession =
    createSessionKey !== undefined &&
    createSessionKey !== previousCreateSessionKey;
  const resetCreateSession =
    initializedCreateSession &&
    !previousIsNewRecord &&
    isEmptyRecord(currentValue);
  const externalEmptyReset =
    initializedCreateSession &&
    currentValue !== lastObservedValue &&
    currentValue !== lastInternalValue &&
    isEmptyRecord(currentValue);
  const shouldApplyDefaults =
    !initializedCreateSession ||
    explicitNewSession ||
    resetCreateSession ||
    (createSessionKey === undefined && externalEmptyReset);

  if (!shouldApplyDefaults) {
    previousIsNewRecord = true;
    previousCreateSessionKey = createSessionKey;
    lastObservedValue = currentValue;
    return;
  }

  const next = { ...currentValue };
  let changed = false;
  for (const field of formFields) {
    const policyField = resolvedPolicy.fields[field.name];
    if (policyField.hasDefault && next[field.name] === undefined) {
      next[field.name] = policyField.defaultValue;
      changed = true;
    }
  }
  initializedCreateSession = true;
  previousIsNewRecord = true;
  previousCreateSessionKey = createSessionKey;
  if (changed) {
    lastInternalValue = next;
    lastObservedValue = next;
    value = next;
  } else {
    lastObservedValue = currentValue;
  }
});

function inputFor(field: ObjectFormField): FieldInputComponent {
  return (
    inputRegistry?.resolve(objectRef, field.name, field.definition.type) ??
    (FieldInput as unknown as Component<FieldInputProps>)
  );
}
</script>

{#snippet renderField(field: ObjectFormField)}
  {@const renderer = renderers[field.name]}
  <PolicyField name={field.name} label={fieldLabel(field)} id={fieldId(field.name)} helpId={`${fieldId(field.name)}-help`} {isNewRecord}>
    {#if renderer}
      {@render renderer({ field, id: fieldId(field.name), helpId: `${fieldId(field.name)}-help`, value: value[field.name], required: resolvedPolicy!.fields[field.name].required, disabled, setValue: (next) => setValue(field.name, next), setValidity: (valid) => setValidity(field.name, valid) })}
    {:else}
      {@const InputComponent = inputFor(field)}
      <InputComponent
        id={fieldId(field.name)}
        name={field.name}
        label={fieldLabel(field)}
        {field}
        value={value[field.name]}
        required={resolvedPolicy!.fields[field.name].required}
        {disabled}
        onvaluechange={(next) => setValue(field.name, next)}
        onvaliditychange={(valid) => setValidity(field.name, valid)}
      />
    {/if}
  </PolicyField>
{/snippet}

{#snippet renderGroups(groups: Array<[string | null, ObjectFormField[]]>)}
  {#each groups as [groupName, groupFields] (groupName ?? '__ungrouped__')}
    {#if groupName}
      <fieldset class="object-form__group">
        <legend>{groupName}</legend>
        {#each groupFields as field (field.name)}
          {@render renderField(field)}
        {/each}
      </fieldset>
    {:else}
      {#each groupFields as field (field.name)}
        {@render renderField(field)}
      {/each}
    {/if}
  {/each}
{/snippet}

{#if sourceLoading}
  <div class="object-form__status" role="status" aria-live="polite">Loading form…</div>
{:else if sourceError}
  <div class="object-form__status" role="alert">{sourceError}</div>
{:else if resolvedPolicy}
<FieldPolicyProvider policy={resolvedPolicy}>
  {#if showModeSwitch || (showPolicyGear && fieldPolicyGear)}
    {#if showModeSwitch}
      <div class="object-form__mode"><ModeSwitch /></div>
    {/if}
    {#if showPolicyGear && fieldPolicyGear}
      <div class="object-form__gear"><FieldPolicyGearButton /></div>
    {/if}
  {/if}
  <Form class="object-form {className}" onsubmit={handleSubmit}>
    {@render renderGroups(basicGroups)}
    {#if advancedGroups.length > 0}
      <AdvancedFields open>
        {@render renderGroups(advancedGroups)}
      </AdvancedFields>
    {/if}
    {@render actions?.()}
  </Form>
</FieldPolicyProvider>
{/if}

<style>
  :global(.object-form) { display: grid; gap: var(--smrt-spacing-4, 1rem); }
  .object-form__mode, .object-form__gear { display: inline-flex; justify-content: flex-end; margin-bottom: var(--smrt-spacing-3, 0.75rem); }
  .object-form__group { display: grid; gap: var(--smrt-spacing-3, 0.75rem); border: 0; margin: 0; min-inline-size: 0; padding: 0; }
  .object-form__group legend { font: var(--smrt-typography-title-small-font, inherit); margin-bottom: var(--smrt-spacing-2, 0.5rem); }
  .object-form__status { color: var(--smrt-color-on-surface-variant, currentColor); }
</style>
