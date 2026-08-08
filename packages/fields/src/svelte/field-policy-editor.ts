/**
 * Transport-neutral client contracts and pure helpers for the policy gear.
 *
 * Hosts normally adapt these methods to their generated FieldPolicyCollection
 * client. Identity is intentionally absent from mutations: the server derives
 * tenant/user scope from the authenticated ambient context.
 */
import type {
  FieldPolicyEditorRow,
  FieldPolicyEditorState,
  FieldPolicyEditorStateResult,
  FieldPolicyScopeType,
} from '../types.js';

export interface FieldPolicyEditorAdapter {
  load(input: { objectRef: string }): Promise<FieldPolicyEditorStateResult>;
  create(input: FieldPolicyEditorMutation): Promise<unknown>;
  update(input: FieldPolicyEditorMutation & { id: string }): Promise<unknown>;
  delete(input: { id: string }): Promise<unknown>;
}

/** Generated-client compatible sparse write shape. `defaultValue` is JSON. */
export interface FieldPolicyEditorMutation {
  objectRef: string;
  fieldName: string;
  scopeType: FieldPolicyScopeType;
  defaultValue: string | null;
  displayOrder: number | null;
  help: string | null;
  label: string | null;
  locked: boolean | null;
  visibility: 'basic' | 'advanced' | 'hidden' | null;
}

export type FieldPolicyEditorTab = 'organization' | 'personal';
export type FieldPolicyOrganizationScope = 'app' | 'tenant';

export interface FieldPolicyEditorDraft {
  defaultEnabled: boolean;
  defaultValue: unknown;
  displayOrder: number | null;
  help: string | null;
  label: string | null;
  locked: boolean | null;
  visibility: 'basic' | 'advanced' | 'hidden' | null;
}

export function isFieldPolicyEditorState(
  result: unknown,
  expectedObjectRef?: string,
): result is FieldPolicyEditorState {
  if (!result || typeof result !== 'object') return false;
  const candidate = result as Partial<FieldPolicyEditorState>;
  return (
    typeof candidate.capabilities?.manage === 'boolean' &&
    typeof candidate.capabilities.personalize === 'boolean' &&
    typeof candidate.policy?.objectRef === 'string' &&
    (expectedObjectRef === undefined ||
      candidate.policy.objectRef === expectedObjectRef) &&
    !!candidate.policy.fields &&
    !!candidate.policy.layers &&
    !!candidate.personalLowerDefaultUsable &&
    Object.values(candidate.personalLowerDefaultUsable).every(
      (usable) => typeof usable === 'boolean',
    ) &&
    Array.isArray(candidate.rows?.app) &&
    Array.isArray(candidate.rows?.tenant) &&
    Array.isArray(candidate.rows?.user)
  );
}

/** Safe message extraction for generated custom actions, whose client type is `any`. */
export function editorStateErrorMessage(result: unknown): string {
  if (
    result &&
    typeof result === 'object' &&
    'message' in result &&
    typeof (result as { message?: unknown }).message === 'string'
  ) {
    return (result as { message: string }).message;
  }
  return 'Unable to load field settings.';
}

export function rowForScope(
  state: FieldPolicyEditorState,
  fieldName: string,
  scope: FieldPolicyScopeType,
): FieldPolicyEditorRow | undefined {
  return state.rows[scope].find((row) => row.fieldName === fieldName);
}

export function draftFromRow(
  row?: FieldPolicyEditorRow,
): FieldPolicyEditorDraft {
  let defaultValue: unknown;
  if (row?.defaultValue != null) {
    try {
      defaultValue = JSON.parse(row.defaultValue);
    } catch {
      // A stale malformed row must not make the editor unusable. The server
      // remains the authority and will reject a subsequently invalid save.
      defaultValue = undefined;
    }
  }
  return {
    defaultEnabled: row?.defaultValue != null,
    defaultValue,
    displayOrder: row?.displayOrder ?? null,
    help: row?.help ?? null,
    label: row?.label ?? null,
    locked: row?.locked ?? null,
    visibility: row?.visibility ?? null,
  };
}

export function mutationFromDraft(
  objectRef: string,
  fieldName: string,
  scopeType: FieldPolicyScopeType,
  draft: FieldPolicyEditorDraft,
): FieldPolicyEditorMutation {
  return {
    objectRef,
    fieldName,
    scopeType,
    defaultValue: draft.defaultEnabled
      ? serializeDefaultValue(draft.defaultValue)
      : null,
    displayOrder: draft.displayOrder,
    help: blankToNull(draft.help),
    label: blankToNull(draft.label),
    locked: scopeType === 'user' ? null : draft.locked,
    visibility: draft.visibility,
  };
}

/**
 * Serialize the explicit default-value wire channel without ever leaking an
 * `undefined` payload into a generated client. JSON null remains intentional.
 */
export function serializeDefaultValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') {
      throw new Error('Choose a default value before saving this override.');
    }
    return serialized;
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message.startsWith('Choose a default')
    ) {
      throw cause;
    }
    throw new Error(
      'This default value cannot be saved because it is not JSON-serializable.',
      { cause },
    );
  }
}

export function defaultValueSerializationError(value: unknown): string | null {
  try {
    serializeDefaultValue(value);
    return null;
  } catch (cause) {
    return cause instanceof Error
      ? cause.message
      : 'This default value cannot be saved.';
  }
}

export function requiredVisibilityIsInvalid(
  required: boolean,
  visibility: FieldPolicyEditorDraft['visibility'],
  effectiveDefault: unknown,
): boolean {
  return (
    required &&
    (visibility === 'advanced' || visibility === 'hidden') &&
    !hasUsableDefault(effectiveDefault)
  );
}

export function hasUsableDefault(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function blankToNull(value: string | null): string | null {
  return value == null || value.trim() === '' ? null : value;
}

/** Structural AdminShell seam; importing smrt-svelte here would invert the DAG. */
export interface FieldPolicyFocusTool {
  id: string;
  label: string;
  description?: string;
  order?: number;
  component?: unknown;
  render?: unknown;
  subject?: { type: string; id: string; label?: string };
}

export interface FieldPolicyFocusToolRegistrar {
  registerFocusTool(tool: FieldPolicyFocusTool): () => void;
}

/**
 * Registers an object-form settings tool with AdminShell-compatible state.
 * AdminShell passes `{ tool, shell }` to a component focus tool; callers pass
 * that component through `tool.component` without Fields importing the shell.
 */
export function registerFieldPolicyFocusTool(
  shell: FieldPolicyFocusToolRegistrar,
  objectRef: string,
  tool: Omit<FieldPolicyFocusTool, 'subject'>,
): () => void {
  return shell.registerFocusTool({
    ...tool,
    subject: { type: 'object-form', id: objectRef },
  });
}
