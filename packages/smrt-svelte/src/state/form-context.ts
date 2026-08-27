/**
 * SMRT Form context for field registration and coordination
 */

import type {
  ControlConstraints,
  ControlExtensionContext,
  ControlInteractionRegistry,
  ControlKind,
  ControlOption,
  ControlRuntimeState,
  ControlSensitivity,
  ControlSubject,
  ControlValueValidationResult,
} from '@happyvertical/smrt-ui/forms';
import { getAllContexts, getContext, setContext } from 'svelte';

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
  /** Context-aware setter for hooks that need to issue another control command. */
  setValueWithContext?: (
    value: unknown,
    context: ControlExtensionContext,
  ) => void | Promise<void>;
  /** Get current field value */
  getValue: () => unknown;
  /**
   * Convert an incoming intent into the final value shown for review/applied.
   * May throw when the value cannot be represented canonically by this field.
   */
  prepareValue?: (value: unknown) => unknown;
  /** Validate/canonicalize a complete value edited in staged review. */
  prepareReviewedValue?: (value: unknown) => unknown;
  /**
   * Convert a value extracted from speech into the field's canonical value.
   * May be asynchronous for controls that support natural-language parsing.
   */
  prepareExtractedValue?: (value: unknown) => unknown | Promise<unknown>;
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
  clear?:
    | ((context?: ControlExtensionContext) => void | Promise<void>)
    | ((context?: ControlExtensionContext) => boolean | Promise<boolean>);
  focus?: () => void;
  reveal?: () => void;
  highlight?: (durationMs?: number) => void;
  validate?: (context?: ControlExtensionContext) => boolean | Promise<boolean>;
  validateValue?: (
    value: unknown,
    context?: ControlExtensionContext,
  ) => ControlValueValidationResult | Promise<ControlValueValidationResult>;
  getState?: () => ControlRuntimeState;
}

/**
 * SMRT Form context interface
 */
export interface SMRTFormContext {
  /** Current mode */
  readonly mode: 'smrt' | 'default';
  /**
   * Register a field with the form. New contexts return an identity-bound
   * disposer; legacy void-returning contexts remain supported.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: void preserves source compatibility with legacy context implementations.
  registerField: (field: FieldDefinition) => void | (() => void);
  /** Legacy name-based cleanup. Prefer the disposer returned by registerField. */
  unregisterField: (name: string) => void;
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

// Svelte gives every component its own context map, copying inherited values
// into that map. Cache a facade by this map rather than by the inherited
// context value: repeated calls from one component share ownership, while
// descendants that inherit a facade receive their own ownership boundary.
const callerFormContextFacades = new WeakMap<
  Map<unknown, unknown>,
  SMRTFormContext
>();

function createFormContextFacade(ctx: SMRTFormContext): SMRTFormContext {
  const registrations = new Map<string, Set<() => void>>();

  const facade: SMRTFormContext = {
    get mode() {
      return ctx.mode;
    },
    registerField(field) {
      const registeredName = field.name;
      const registeredDisposer = ctx.registerField(field);
      const disposeField =
        typeof registeredDisposer === 'function'
          ? registeredDisposer
          : () => ctx.unregisterField(registeredName);
      let active = true;
      const dispose = () => {
        if (!active) return;
        active = false;
        const ownedRegistrations = registrations.get(registeredName);
        ownedRegistrations?.delete(dispose);
        if (ownedRegistrations?.size === 0) {
          registrations.delete(registeredName);
        }
        disposeField();
      };
      const ownedRegistrations = registrations.get(registeredName) ?? new Set();
      ownedRegistrations.add(dispose);
      registrations.set(registeredName, ownedRegistrations);
      return dispose;
    },
    unregisterField(name) {
      const ownedRegistrations = registrations.get(name);
      const dispose = ownedRegistrations?.values().next().value;
      dispose?.();
    },
    getFieldSchema: () => ctx.getFieldSchema(),
    get isFormListening() {
      return ctx.isFormListening;
    },
    get isExtracting() {
      return ctx.isExtracting;
    },
    toggleListening: () => ctx.toggleListening(),
    get interactionRegistry() {
      return ctx.interactionRegistry;
    },
    get formId() {
      return ctx.formId;
    },
  };
  return facade;
}

function getCallerFormContext(required: true): SMRTFormContext;
function getCallerFormContext(required: false): SMRTFormContext | null;
function getCallerFormContext(required: boolean): SMRTFormContext | null {
  const contextMap = getAllContexts();
  const existingFacade = callerFormContextFacades.get(contextMap);
  if (existingFacade) return existingFacade;

  const ctx = getContext<SMRTFormContext>(SMRT_FORM_KEY);
  if (!ctx) {
    if (!required) return null;
    throw new Error(
      'Form context not found. Make sure to wrap your inputs with <SMRTForm>',
    );
  }

  const facade = createFormContextFacade(ctx);
  callerFormContextFacades.set(contextMap, facade);
  setContext(SMRT_FORM_KEY, facade);
  return facade;
}

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
  return getCallerFormContext(true);
}

/**
 * Try to get form context (returns null if not available)
 */
export function tryGetFormContext(): SMRTFormContext | null {
  return getCallerFormContext(false);
}
