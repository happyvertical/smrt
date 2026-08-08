<script lang="ts">
/** Accessible, transport-neutral editor for context-derived policy rows. */

import { Modal } from '@happyvertical/smrt-ui/feedback';
import { Input, Select, Toggle } from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
import { type Component, untrack } from 'svelte';
import type {
  FieldPolicyEditorState,
  FieldPolicyScopeType,
} from '../../types.js';
import {
  defaultValueSerializationError,
  draftFromRow,
  type FieldPolicyEditorAdapter,
  type FieldPolicyEditorDraft,
  type FieldPolicyEditorTab,
  type FieldPolicyOrganizationScope,
  mutationFromDraft,
  requiredVisibilityIsInvalid,
  rowForScope,
} from '../field-policy-editor.js';
import type {
  FieldInputComponent,
  FieldInputRegistry,
} from '../input-registry.js';
import type { FieldInputProps, ObjectFormFieldDefinition } from '../types.js';
import FieldInput from './FieldInput.svelte';

interface Props {
  state: FieldPolicyEditorState;
  adapter: FieldPolicyEditorAdapter;
  fields: Readonly<Record<string, ObjectFormFieldDefinition>>;
  inputRegistry?: FieldInputRegistry;
  organizationScope?: FieldPolicyOrganizationScope;
  onclose: () => void;
  onmutated: () => Promise<void>;
}

let {
  state: editorState,
  adapter,
  fields,
  inputRegistry,
  organizationScope = 'tenant',
  onclose,
  onmutated,
}: Props = $props();

let tab = $state<FieldPolicyEditorTab>(
  untrack(() =>
    editorState.capabilities.manage ? 'organization' : 'personal',
  ),
);
let drafts = $state<Record<string, FieldPolicyEditorDraft>>({});
let saving = $state<string | null>(null);
let error = $state<string | null>(null);
let invalidDefaults = $state<Set<string>>(new Set());
const tabInstanceId = $props.id();

const scope = $derived<FieldPolicyScopeType>(
  tab === 'organization' ? organizationScope : 'user',
);
const availableTabs = $derived<FieldPolicyEditorTab[]>([
  ...(editorState.capabilities.manage ? (['organization'] as const) : []),
  ...(editorState.capabilities.personalize ? (['personal'] as const) : []),
]);
const orderedFields = $derived(
  Object.values(editorState.policy.fields).sort(
    (left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) -
        (right.order ?? Number.MAX_SAFE_INTEGER) ||
      left.fieldName.localeCompare(right.fieldName),
  ),
);

function tabId(tabName: FieldPolicyEditorTab): string {
  return `field-policy-tab-${tabInstanceId}-${tabName}`;
}

function tabPanelId(tabName: FieldPolicyEditorTab): string {
  return `field-policy-panel-${tabInstanceId}-${tabName}`;
}

function selectTab(nextTab: FieldPolicyEditorTab, focus = false): void {
  tab = nextTab;
  if (focus) {
    // The selected button receives tabindex=0 after this reactive update.
    requestAnimationFrame(() => {
      document.getElementById(tabId(nextTab))?.focus();
    });
  }
}

function handleTabKeydown(
  event: KeyboardEvent,
  currentTab: FieldPolicyEditorTab,
): void {
  const currentIndex = availableTabs.indexOf(currentTab);
  if (currentIndex === -1 || availableTabs.length < 2) return;

  let nextIndex: number | null = null;
  switch (event.key) {
    case 'ArrowRight':
      nextIndex = (currentIndex + 1) % availableTabs.length;
      break;
    case 'ArrowLeft':
      nextIndex =
        (currentIndex - 1 + availableTabs.length) % availableTabs.length;
      break;
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = availableTabs.length - 1;
      break;
    default:
      return;
  }

  event.preventDefault();
  const nextTab = availableTabs[nextIndex];
  if (nextTab) selectTab(nextTab, true);
}

function draftFor(fieldName: string): FieldPolicyEditorDraft {
  const key = `${scope}:${fieldName}`;
  return (
    drafts[key] ?? draftFromRow(rowForScope(editorState, fieldName, scope))
  );
}

function setDraft(
  fieldName: string,
  patch: Partial<FieldPolicyEditorDraft>,
): void {
  const key = `${scope}:${fieldName}`;
  drafts[key] = { ...draftFor(fieldName), ...patch };
}

function defaultValueFor(fieldName: string): unknown {
  const draft = draftFor(fieldName);
  if (draft.defaultEnabled) return draft.defaultValue;
  const row = rowForScope(editorState, fieldName, scope);
  // Clearing a current row must not count its own resolved default. Replay
  // only lower layers, preserving explicit null as a present (unusable) default.
  if (row?.defaultValue != null) {
    // Personal callers intentionally receive no org rows/layers. The server
    // supplies only whether the hidden code/app/tenant fallback is usable,
    // which is enough to enforce the required-field invariant without
    // disclosing any lower-layer default value.
    if (scope === 'user') {
      return editorState.personalLowerDefaultUsable[fieldName]
        ? true
        : undefined;
    }
    const definition = fields[fieldName];
    let fallback: unknown =
      definition && Object.hasOwn(definition, 'default')
        ? definition.default
        : undefined;
    for (const layer of editorState.policy.layers[fieldName] ?? []) {
      if (scope === 'app' && layer.layer !== 'code') continue;
      if (scope === 'tenant' && layer.layer === 'user') continue;
      if (
        scope === 'tenant' &&
        layer.layer === 'tenant' &&
        layer.tenantId === row.tenantId
      )
        continue;
      if (layer.delta.default) fallback = layer.delta.default.value;
    }
    return fallback;
  }
  return editorState.policy.fields[fieldName].defaultValue;
}

function userLocked(fieldName: string): boolean {
  return scope === 'user' && editorState.policy.fields[fieldName].locked;
}

function invalidRequiredDemotion(fieldName: string): boolean {
  const field = editorState.policy.fields[fieldName];
  const draft = draftFor(fieldName);
  return requiredVisibilityIsInvalid(
    field.required,
    draft.visibility,
    defaultValueFor(fieldName),
  );
}

function defaultSerializationError(fieldName: string): string | null {
  const draft = draftFor(fieldName);
  if (draft.defaultEnabled && invalidDefaults.has(`${scope}:${fieldName}`)) {
    return 'Enter valid JSON before saving this default.';
  }
  return draft.defaultEnabled
    ? defaultValueSerializationError(draft.defaultValue)
    : null;
}

function setDefaultValidity(
  fieldScope: FieldPolicyScopeType,
  fieldName: string,
  valid: boolean,
): void {
  const next = new Set(invalidDefaults);
  const key = `${fieldScope}:${fieldName}`;
  if (valid) next.delete(key);
  else next.add(key);
  invalidDefaults = next;
}

function inputFor(fieldName: string): FieldInputComponent {
  const definition = fields[fieldName];
  return (
    inputRegistry?.resolve(
      editorState.policy.objectRef,
      fieldName,
      definition?.type ?? 'text',
    ) ?? (FieldInput as unknown as Component<FieldInputProps>)
  );
}

function editorField(fieldName: string) {
  const definition = fields[fieldName] ?? { type: 'text' };
  const policy = editorState.policy.fields[fieldName];
  return {
    name: fieldName,
    definition,
    group: policy.group,
    order: policy.order,
  };
}

async function save(fieldName: string): Promise<void> {
  if (
    userLocked(fieldName) ||
    invalidRequiredDemotion(fieldName) ||
    defaultSerializationError(fieldName)
  ) {
    return;
  }
  saving = fieldName;
  error = null;
  try {
    const row = rowForScope(editorState, fieldName, scope);
    const mutation = mutationFromDraft(
      editorState.policy.objectRef,
      fieldName,
      scope,
      draftFor(fieldName),
    );
    if (row) await adapter.update({ ...mutation, id: row.id });
    else await adapter.create(mutation);
    drafts = {};
    await onmutated();
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : 'Unable to save field settings.';
  } finally {
    saving = null;
  }
}

async function reset(fieldName: string): Promise<void> {
  const row = rowForScope(editorState, fieldName, scope);
  if (!row || userLocked(fieldName)) return;
  saving = fieldName;
  error = null;
  try {
    await adapter.delete({ id: row.id });
    drafts = {};
    await onmutated();
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : 'Unable to reset field settings.';
  } finally {
    saving = null;
  }
}
</script>

<Modal open={true} onClose={onclose} title="Field settings" size="xl" ariaDescribedBy="field-policy-editor-description">
<div class="field-policy-editor">
  <p id="field-policy-editor-description">Overrides are sparse. Reset removes this scope’s row and inherits the effective policy.</p>

  <div class="field-policy-editor__tabs" role="tablist" aria-label="Field policy scope">
    {#if editorState.capabilities.manage}
      <Button
        type="button"
        role="tab"
        id={tabId('organization')}
        aria-selected={tab === 'organization'}
        aria-controls={tabPanelId('organization')}
        tabindex={tab === 'organization' ? 0 : -1}
        onclick={() => selectTab('organization')}
        onkeydown={(event: KeyboardEvent) => handleTabKeydown(event, 'organization')}
      >
        Organization
      </Button>
    {/if}
    {#if editorState.capabilities.personalize}
      <Button
        type="button"
        role="tab"
        id={tabId('personal')}
        aria-selected={tab === 'personal'}
        aria-controls={tabPanelId('personal')}
        tabindex={tab === 'personal' ? 0 : -1}
        onclick={() => selectTab('personal')}
        onkeydown={(event: KeyboardEvent) => handleTabKeydown(event, 'personal')}
      >
        Just me
      </Button>
    {/if}
  </div>

  {#if error}
    <p class="field-policy-editor__error" role="alert">{error}</p>
  {/if}

  <div
    role="tabpanel"
    id={tabPanelId(tab)}
    aria-labelledby={tabId(tab)}
    aria-label={tab === 'organization' ? 'Organization settings' : 'Personal settings'}
  >
    {#each orderedFields as policyField (policyField.fieldName)}
      {@const fieldName = policyField.fieldName}
      {@const defaultScope = scope}
      {@const draft = draftFor(fieldName)}
      {@const InputComponent = inputFor(fieldName)}
      <fieldset class="field-policy-editor__field" disabled={userLocked(fieldName) || saving === fieldName}>
        <legend>{policyField.label ?? fieldName}</legend>
        {#if userLocked(fieldName)}
          <p class="field-policy-editor__notice">This field is locked by your organization and cannot be personalized.</p>
        {/if}
        {#if policyField.required}
          <p id={`${fieldName}-required-invariant`} class="field-policy-editor__notice">
            Required fields without a usable default must remain Basic.
          </p>
        {/if}
        <label>
          Visibility
          <Select
            value={draft.visibility ?? ''}
            aria-describedby={policyField.required ? `${fieldName}-required-invariant` : undefined}
            onchange={(event: Event) => setDraft(fieldName, { visibility: ((event.currentTarget as HTMLSelectElement).value || null) as FieldPolicyEditorDraft['visibility'] })}
          >
            <option value="">Inherit</option>
            <option value="basic">Basic</option>
            <option value="advanced">Advanced</option>
            <option value="hidden">Hidden</option>
          </Select>
        </label>
        {#if invalidRequiredDemotion(fieldName)}
          <p class="field-policy-editor__error" role="status">Add a usable default before making this required field advanced or hidden.</p>
        {/if}
        <Toggle
          checked={draft.defaultEnabled}
          label="Override default value"
          onchange={(value) => {
            setDraft(fieldName, { defaultEnabled: value });
            if (!value) setDefaultValidity(defaultScope, fieldName, true);
          }}
        />
        {#if draft.defaultEnabled}
          <label for={`${fieldName}-default`}>Default value</label>
          {#key `${scope}:${fieldName}`}
            <InputComponent
              id={`${fieldName}-default`}
              name={`${fieldName}-default`}
              label={`Default ${policyField.label ?? fieldName}`}
              field={editorField(fieldName)}
              value={draft.defaultValue}
              required={false}
              disabled={false}
              onvaluechange={(value) => setDraft(fieldName, { defaultValue: value })}
              onvaliditychange={(valid) => setDefaultValidity(defaultScope, fieldName, valid)}
            />
          {/key}
          {#if defaultSerializationError(fieldName)}
            <p class="field-policy-editor__error" role="status">
              {defaultSerializationError(fieldName)}
            </p>
          {/if}
        {/if}
        <label>Label <Input value={draft.label ?? ''} oninput={(event: Event) => setDraft(fieldName, { label: (event.currentTarget as HTMLInputElement).value })} /></label>
        <label>Help <Input value={draft.help ?? ''} oninput={(event: Event) => setDraft(fieldName, { help: (event.currentTarget as HTMLInputElement).value })} /></label>
        <label>Display order <Input type="number" value={draft.displayOrder ?? ''} oninput={(event: Event) => { const value = (event.currentTarget as HTMLInputElement).value; setDraft(fieldName, { displayOrder: value === '' ? null : Number(value) }); }} /></label>
        {#if scope !== 'user'}
          <Toggle checked={draft.locked === true} ariaLabel={`Lock ${policyField.label ?? fieldName}`} onchange={(value) => setDraft(fieldName, { locked: value ? true : null })} />
          <span>Lock personal overrides</span>
        {/if}
        <div class="field-policy-editor__actions">
          <Button type="button" onclick={() => save(fieldName)} disabled={invalidRequiredDemotion(fieldName) || !!defaultSerializationError(fieldName)}>{saving === fieldName ? 'Saving…' : 'Save'}</Button>
          {#if rowForScope(editorState, fieldName, scope)}
            <Button type="button" variant="ghost" onclick={() => reset(fieldName)}>Reset to inherited</Button>
          {/if}
        </div>
      </fieldset>
    {/each}
  </div>
</div>
</Modal>

<style>
  .field-policy-editor { background: var(--smrt-color-surface, white); color: var(--smrt-color-on-surface, #1f2937); display: grid; gap: var(--smrt-spacing-4, 1rem); max-block-size: min(90vh, 56rem); overflow: auto; padding: var(--smrt-spacing-5, 1.25rem); }
  .field-policy-editor__actions, .field-policy-editor__tabs { align-items: center; display: flex; gap: var(--smrt-spacing-2, .5rem); justify-content: space-between; }
  .field-policy-editor__field { border: 1px solid var(--smrt-color-outline, #d0d5dd); display: grid; gap: var(--smrt-spacing-3, .75rem); margin: 0 0 var(--smrt-spacing-3, .75rem); padding: var(--smrt-spacing-3, .75rem); }
  .field-policy-editor__field label { display: grid; gap: var(--smrt-spacing-1, .25rem); }
  .field-policy-editor__error { color: var(--smrt-color-error, #b42318); }
  .field-policy-editor__notice { margin: 0; }
</style>
