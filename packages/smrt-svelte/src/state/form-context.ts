/**
 * SMRT Form context for field registration and coordination
 */

import type {
  ControlConstraints,
  ControlInteractionRegistry,
  ControlKind,
  ControlOption,
  ControlRuntimeState,
  ControlSensitivity,
  ControlSubject,
  ControlValueValidationResult,
} from '@happyvertical/smrt-ui/forms';
import { getContext, setContext } from 'svelte';

/**
 * Field definition for form registration
 */
/** All supported form field types */
export type FormFieldType =
  | 'text'
  | 'email'
  | 'datetime'
  | 'number'
  | 'address'
  | 'checkbox'
  | 'daterange'
  | 'measurement'
  | 'money'
  | 'phone'
  | 'select'
  | 'textarea';

export interface FieldDefinition {
  /** Field name (used as key for LLM extraction) */
  name: string;
  /** Field type */
  type: FormFieldType;
  /** Human-readable label */
  label?: string;
  /** Description to help LLM understand field purpose */
  description?: string;
  /** Set the field value */
  setValue: (value: unknown) => void;
  /** Get current field value */
  getValue: () => unknown;
  /**
   * Convert an incoming intent into the final value shown for review/applied.
   * May throw when the value cannot be represented canonically by this field.
   */
  prepareValue?: (value: unknown) => unknown;
  /** Optional richer interaction metadata and capabilities. */
  controlId?: string;
  /** Immutable token identifying the DOM subtree owned by this field. */
  ownerToken?: string;
  subject?: ControlSubject;
  interactionKind?: ControlKind;
  sensitivity?: ControlSensitivity;
  readable?: boolean;
  writable?: boolean;
  constraints?: ControlConstraints;
  /** Optional WebMCP schema override for structured field values. */
  webMcpSchema?: Record<string, unknown>;
  options?: ControlOption[];
  unit?: string;
  /** Return true to affirm an accepted idempotent clear; false rejects it. */
  clear?: (() => void | Promise<void>) | (() => boolean | Promise<boolean>);
  focus?: () => void;
  reveal?: () => void;
  highlight?: (durationMs?: number) => void;
  validate?: () => boolean;
  validateValue?: (value: unknown) => ControlValueValidationResult;
  getState?: () => ControlRuntimeState;
}

/**
 * SMRT Form context interface
 */
export interface SMRTFormContext {
  /** Current mode */
  readonly mode: 'smrt' | 'default';
  /** Register a field with the form */
  registerField: (field: FieldDefinition) => () => void;
  /** Get all registered fields schema (for LLM prompt) */
  getFieldSchema: () => FieldDefinition[];
  /** Whether form-level listening is active */
  readonly isFormListening: boolean;
  /** Whether currently extracting from speech */
  readonly isExtracting: boolean;
  /** Toggle form-level listening on/off */
  toggleListening: () => void;
  /** Shared transport-neutral registry used by voice/chat/tutorial adapters. */
  readonly interactionRegistry: ControlInteractionRegistry;
  readonly formId: string;
}

/**
 * Context key for SMRT form
 */
export const SMRT_FORM_KEY = Symbol('smrt-form');

/**
 * Set form context (used by SMRTForm)
 */
export function setFormContext(ctx: SMRTFormContext): void {
  setContext(SMRT_FORM_KEY, ctx);
}

/**
 * Get form context
 * @throws If called outside of SMRTForm
 */
export function getFormContext(): SMRTFormContext {
  const ctx = getContext<SMRTFormContext>(SMRT_FORM_KEY);

  if (!ctx) {
    throw new Error(
      'Form context not found. Make sure to wrap your inputs with <SMRTForm>',
    );
  }

  return ctx;
}

/**
 * Try to get form context (returns null if not available)
 */
export function tryGetFormContext(): SMRTFormContext | null {
  return getContext<SMRTFormContext>(SMRT_FORM_KEY) ?? null;
}
