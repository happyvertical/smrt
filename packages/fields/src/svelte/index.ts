/**
 * @happyvertical/smrt-fields/svelte
 *
 * Headless form primitives for policy-driven forms (#2048). These components
 * consume a pre-resolved {@link ResolvedObjectFieldPolicy} (from
 * `@happyvertical/smrt-fields`) and contribute visibility-by-mode, default
 * prefill, label/help rendering, and progressive disclosure — without owning
 * markup or layout.
 *
 * The primitives are policy-source agnostic: the app passes the resolved
 * policy as props (SSR `initialData` or a client fetch). No `smrt-web` import
 * in the core — an optional `./web` adapter can wire live invalidation for
 * apps that want it.
 *
 * @packageDocumentation
 */

import type { ComponentProps } from 'svelte';
import AdvancedFields from './components/AdvancedFields.svelte';
import FieldPolicyControlPanel from './components/FieldPolicyControlPanel.svelte';
import FieldPolicyEditor from './components/FieldPolicyEditor.svelte';
import FieldPolicyGearButton from './components/FieldPolicyGearButton.svelte';
import FieldPolicyGearProvider from './components/FieldPolicyGearProvider.svelte';
import FieldPolicyProvider from './components/FieldPolicyProvider.svelte';
import FieldPolicySuggestionQueue from './components/FieldPolicySuggestionQueue.svelte';
import FormHelp from './components/FormHelp.svelte';
import ModeSwitch from './components/ModeSwitch.svelte';
import ObjectForm from './components/ObjectForm.svelte';
import ObjectFormSourceProvider from './components/ObjectFormSourceProvider.svelte';
import PolicyField from './components/PolicyField.svelte';

// Components
export {
  AdvancedFields,
  FieldPolicyControlPanel,
  FieldPolicyEditor,
  FieldPolicyGearButton,
  FieldPolicyGearProvider,
  FieldPolicyProvider,
  FieldPolicySuggestionQueue,
  FormHelp,
  ModeSwitch,
  ObjectForm,
  ObjectFormSourceProvider,
  PolicyField,
};

// Component prop types
export type AdvancedFieldsProps = ComponentProps<typeof AdvancedFields>;
export type FieldPolicyProviderProps = ComponentProps<
  typeof FieldPolicyProvider
>;
export type FormHelpProps = ComponentProps<typeof FormHelp>;
export type ModeSwitchProps = ComponentProps<typeof ModeSwitch>;
export type ObjectFormProps = ComponentProps<typeof ObjectForm>;
export type {
  ObjectFormSubmitAcknowledgement,
  ObjectFormSubmitHandler,
} from './components/ObjectForm.svelte';
export type ObjectFormSourceProviderProps = ComponentProps<
  typeof ObjectFormSourceProvider
>;
export type FieldPolicyEditorProps = ComponentProps<typeof FieldPolicyEditor>;
export type FieldPolicyControlPanelProps = ComponentProps<
  typeof FieldPolicyControlPanel
>;
export type FieldPolicyGearButtonProps = ComponentProps<
  typeof FieldPolicyGearButton
>;
export type FieldPolicyGearProviderProps = ComponentProps<
  typeof FieldPolicyGearProvider
>;
export type FieldPolicySuggestionQueueProps = ComponentProps<
  typeof FieldPolicySuggestionQueue
>;
export type PolicyFieldProps = ComponentProps<typeof PolicyField>;

export type {
  FieldPolicyCatalogObjectSummary,
  FieldPolicyDetailItem,
  FieldPolicySettingsCatalogData,
  FieldPolicySettingsCatalogPage,
  FieldPolicySummaryItem,
} from '../settings-catalog.js';
// Re-export resolved-policy types consumers need (from the core package)
export type {
  ResolvedFieldPolicy,
  ResolvedObjectFieldPolicy,
} from '../types.js';
export type {
  FieldPolicyContextValue,
  FieldPolicyMode,
} from './context.svelte.js';
// Context types and accessors
export {
  getFieldPolicyContext,
  setFieldPolicyContext,
  tryGetFieldPolicyContext,
} from './context.svelte.js';
export type { PolicyDataTableColumn } from './data-table.js';
export { policyToVisibleColumnIds } from './data-table.js';
export type {
  FieldPolicyEditorAdapter,
  FieldPolicyEditorDraft,
  FieldPolicyEditorMutation,
  FieldPolicyEditorTab,
  FieldPolicyFocusTool,
  FieldPolicyFocusToolRegistrar,
  FieldPolicyOrganizationScope,
} from './field-policy-editor.js';
export {
  defaultValueSerializationError,
  draftFromRow,
  editorStateErrorMessage,
  hasUsableDefault,
  isFieldPolicyEditorState,
  mutationFromDraft,
  registerFieldPolicyFocusTool,
  requiredVisibilityIsInvalid,
  rowForScope,
  serializeDefaultValue,
} from './field-policy-editor.js';
export type { FieldPolicyGearController } from './gear-context.svelte.js';
export {
  getFieldPolicyGearContext,
  setFieldPolicyGearContext,
  tryGetFieldPolicyGearContext,
} from './gear-context.svelte.js';
export type { FieldInputComponent } from './input-registry.js';
export {
  createFieldInputRegistry,
  FieldInputRegistry,
} from './input-registry.js';
export { resolveObjectFormFields } from './object-form.js';
export {
  assertObjectFormCollectionDefinition,
  ObjectFormSourceRegistry,
} from './object-form-source.svelte.js';
export type {
  FieldPolicyControlPanelAdapter,
  FieldPolicyFieldRollup,
  FieldPolicyLayerCell,
} from './settings-catalog.js';
export {
  auditObjectRefs,
  decorateCatalogItem,
  decorateCatalogPage,
  fieldPolicyControlPanelNavItem,
  fieldPolicyRollup,
  MAX_FIELD_POLICY_AUDIT_OBJECT_REFS,
  orgRowIdsForObject,
  prunableDriftRows,
} from './settings-catalog.js';
export {
  type FieldPolicySuggestion,
  type FieldPolicySuggestionAdapter,
  type FieldPolicySuggestionKind,
  fieldPolicySuggestionEvidence,
  parsePendingFieldPolicySuggestions,
} from './suggestions.js';
// Snippet escape-hatch props
export type {
  FieldInputProps,
  ObjectFormCollectionDefinition,
  ObjectFormField,
  ObjectFormFieldDefinition,
  ObjectFormFieldSnippetProps,
  ObjectFormPolicyClient,
  ObjectFormResolvedSource,
  ObjectFormSource,
  ObjectFormWireType,
  PolicyFieldSnippetProps,
} from './types.js';
export {
  type CollectFieldUsageEntriesOptions,
  canCaptureFieldUsageValue,
  collectFieldUsageEntries,
  type FieldUsageDefault,
  type FieldUsageEntry,
  type FieldUsageReporter,
  type FieldUsageWireType,
  fieldUsageValuesEqual,
  isBlankFieldValue,
  reportFieldUsage,
} from './usage-capture.js';
