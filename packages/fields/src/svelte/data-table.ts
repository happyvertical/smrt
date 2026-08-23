/** Pure adapter between resolved field policy and smrt-ui DataTable columns. */
import type { ResolvedObjectFieldPolicy } from '../types.js';

export interface PolicyDataTableColumn {
  id: string;
  /** DataTable still enforces this independently; excluding it here is useful
   * to callers that inspect the returned set before rendering. */
  hidden?: boolean;
  sensitivity?: 'sensitive' | 'secret';
  readable?: boolean;
}

export interface PolicyDataTableOptions {
  /** Explicit host authorization for otherwise restricted columns. */
  authorizedColumnIds?: readonly string[];
}

function isRestrictedColumn(column: PolicyDataTableColumn): boolean {
  return (
    column.readable === false ||
    column.sensitivity === 'sensitive' ||
    column.sensitivity === 'secret'
  );
}

/**
 * Produce DataTable's `visibleColumnIds` set from a resolved policy.
 *
 * Only policy-mapped hidden fields are removed. Columns with no matching field
 * remain visible so computed, selection, and action columns keep working.
 * Static `column.hidden` remains authoritative and can never be undone.
 */
export function policyToVisibleColumnIds(
  policy: ResolvedObjectFieldPolicy,
  columns: readonly PolicyDataTableColumn[],
  fieldNameByColumnId: Readonly<Record<string, string>> = {},
  options: PolicyDataTableOptions = {},
): Set<string> {
  const visible = new Set<string>();
  for (const column of columns) {
    if (column.hidden) continue;
    if (
      isRestrictedColumn(column) &&
      !options.authorizedColumnIds?.includes(column.id)
    ) {
      continue;
    }
    const fieldName = fieldNameByColumnId[column.id] ?? column.id;
    const field = policy.fields[fieldName];
    if (field?.visibility !== 'hidden') visible.add(column.id);
  }
  return visible;
}
