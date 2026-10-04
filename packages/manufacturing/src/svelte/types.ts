/**
 * Serializable view types and pure helpers for the manufacturing components.
 *
 * Components take plain view objects (not model instances) so hosts can pass
 * data across the server/client boundary.
 */

/** One row of `OperationList`; an `Operation` satisfies it. */
export interface OperationView {
  /** The `Operation` id. */
  id: string;
  code: string;
  name: string;
  category: string;
  isActive: boolean;
  /** Plain string id of the required qualification; empty or omitted for none. */
  requiredQualificationId?: string;
}

/** Existing values passed to `OperationForm` when editing. */
export interface OperationFormInitial {
  code: string;
  name: string;
  category: string;
  requiredQualificationId: string;
}

/**
 * What `OperationForm` hands to `onsubmit`; values are trimmed. A host maps a
 * new operation onto `OperationService.define`, and an edit onto `rename` and
 * `update` for the values that differ (the code never changes).
 */
export interface OperationFormValues {
  code: string;
  name: string;
  category: string;
  requiredQualificationId: string;
}

/** A field `validateOperationForm` can reject. */
export type OperationFormField = 'code' | 'name';

/** Result of {@link validateOperationForm}. */
export type OperationFormValidation =
  | { ok: true; values: OperationFormValues }
  | { ok: false; invalid: OperationFormField[] };

/** The raw text `OperationForm` collects, before trimming and checks. */
export interface OperationFormDraft {
  code: string;
  name: string;
  category: string;
  requiredQualificationId: string;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Map an operation's state onto `StatusBadge` default color-scheme keys. */
export function operationStatusBadgeKey(isActive: boolean): string {
  return isActive ? 'active' : 'inactive';
}

/** Trim a form draft and check the required fields: code and name. */
export function validateOperationForm(
  draft: Readonly<Partial<OperationFormDraft>>,
): OperationFormValidation {
  const code = textOf(draft.code);
  const name = textOf(draft.name);
  const invalid: OperationFormField[] = [];
  if (!code) invalid.push('code');
  if (!name) invalid.push('name');
  if (invalid.length > 0) return { ok: false, invalid };
  return {
    ok: true,
    values: {
      code,
      name,
      category: textOf(draft.category),
      requiredQualificationId: textOf(draft.requiredQualificationId),
    },
  };
}
