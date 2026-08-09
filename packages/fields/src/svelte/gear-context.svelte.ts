import { getContext, setContext } from 'svelte';
import type { FieldPolicyEditorState } from '../types.js';

export interface FieldPolicyGearController {
  readonly state: FieldPolicyEditorState | null;
  readonly error: string | null;
  readonly open: boolean;
  readonly canEdit: boolean;
  /** Pending reviewed suggestions for this form's object, when configured. */
  readonly pendingSuggestionCount: number;
  show(): void;
  hide(): void;
  reload(): Promise<void>;
}

const FIELD_POLICY_GEAR_CONTEXT = Symbol('smrt-field-policy-gear');

export function setFieldPolicyGearContext(
  controller: FieldPolicyGearController,
): void {
  setContext(FIELD_POLICY_GEAR_CONTEXT, controller);
}

export function getFieldPolicyGearContext(): FieldPolicyGearController {
  const context = tryGetFieldPolicyGearContext();
  if (!context) {
    throw new Error(
      'Field policy gear context not found. Wrap the form in FieldPolicyGearProvider.',
    );
  }
  return context;
}

export function tryGetFieldPolicyGearContext():
  | FieldPolicyGearController
  | undefined {
  return getContext<FieldPolicyGearController | undefined>(
    FIELD_POLICY_GEAR_CONTEXT,
  );
}
