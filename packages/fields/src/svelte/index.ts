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
import FieldPolicyProvider from './components/FieldPolicyProvider.svelte';
import FormHelp from './components/FormHelp.svelte';
import ModeSwitch from './components/ModeSwitch.svelte';
import PolicyField from './components/PolicyField.svelte';

// Components
export {
  AdvancedFields,
  FieldPolicyProvider,
  FormHelp,
  ModeSwitch,
  PolicyField,
};

// Component prop types
export type AdvancedFieldsProps = ComponentProps<typeof AdvancedFields>;
export type FieldPolicyProviderProps = ComponentProps<
  typeof FieldPolicyProvider
>;
export type FormHelpProps = ComponentProps<typeof FormHelp>;
export type ModeSwitchProps = ComponentProps<typeof ModeSwitch>;
export type PolicyFieldProps = ComponentProps<typeof PolicyField>;

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
// Snippet escape-hatch props
export type { PolicyFieldSnippetProps } from './types.js';
