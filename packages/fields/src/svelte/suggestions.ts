/**
 * Structural browser contracts for field-policy suggestion review.
 *
 * These types intentionally omit tenant, user, authorization, and field
 * sensitivity data. Hosts bind methods to authenticated generated clients;
 * the server derives identity and validates every action.
 */

export type FieldPolicySuggestionKind = 'promote' | 'default';

export interface FieldPolicySuggestion {
  id: string;
  objectRef: string;
  fieldName: string;
  kind: FieldPolicySuggestionKind;
  proposedValue: string | null;
  evidence: Readonly<Record<string, unknown>>;
}

export interface FieldPolicySuggestionAdapter {
  pendingSuggestions(input?: {
    objectRefs?: readonly string[];
  }): Promise<unknown>;
  acceptSuggestion(input: { id: string }): Promise<unknown>;
  dismissSuggestion(input: { id: string }): Promise<unknown>;
}

/**
 * Validate generated custom-action output at the browser boundary. A malformed
 * response is an error, never an empty queue that could conceal work.
 */
export function parsePendingFieldPolicySuggestions(value: unknown): {
  suggestions: FieldPolicySuggestion[];
  total: number;
} {
  if (!value || typeof value !== 'object') {
    throw new Error('Unable to load pending field suggestions.');
  }
  const candidate = value as {
    suggestions?: unknown;
    total?: unknown;
  };
  const total = candidate.total;
  if (
    !Array.isArray(candidate.suggestions) ||
    typeof total !== 'number' ||
    !Number.isSafeInteger(total) ||
    total < 0
  ) {
    throw new Error('Unable to load pending field suggestions.');
  }
  const suggestions = candidate.suggestions.map(parseSuggestion);
  if (total < suggestions.length) {
    throw new Error('Unable to load pending field suggestions.');
  }
  return { suggestions, total };
}

function parseSuggestion(value: unknown): FieldPolicySuggestion {
  if (!value || typeof value !== 'object') {
    throw new Error('Unable to load pending field suggestions.');
  }
  const candidate = value as Partial<FieldPolicySuggestion> & {
    status?: unknown;
  };
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.objectRef !== 'string' ||
    typeof candidate.fieldName !== 'string' ||
    (candidate.kind !== 'promote' && candidate.kind !== 'default') ||
    (candidate.proposedValue !== null &&
      typeof candidate.proposedValue !== 'string') ||
    !isRecord(candidate.evidence) ||
    (candidate.status !== undefined && candidate.status !== 'pending')
  ) {
    throw new Error('Unable to load pending field suggestions.');
  }
  return {
    id: candidate.id,
    objectRef: candidate.objectRef,
    fieldName: candidate.fieldName,
    kind: candidate.kind,
    proposedValue: candidate.proposedValue,
    evidence: candidate.evidence,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Human-readable evidence without assuming a server-side evidence schema. */
export function fieldPolicySuggestionEvidence(
  suggestion: FieldPolicySuggestion,
): string {
  const summary = suggestion.evidence.summary;
  if (typeof summary === 'string' && summary.trim()) return summary;
  const distinctUsers = suggestion.evidence.distinctUsers;
  const setCount = suggestion.evidence.setCount;
  if (typeof distinctUsers === 'number' && typeof setCount === 'number') {
    return `${distinctUsers} users set this field ${setCount} times.`;
  }
  return 'Based on recent organization field usage.';
}
