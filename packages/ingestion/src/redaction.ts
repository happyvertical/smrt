/** Action states whose external outcome may still need reconciliation. */
export const UNFINISHED_ACTION_STATES = [
  'executing',
  'outcome_unknown',
] as const;

/**
 * The retained ceiling of a privacy-redacted receipt. `execution.principalId`
 * is kept only while an external action may still be reconciled under it;
 * otherwise it would name the person after every other link is gone.
 */
export function redactedCeiling(
  ceiling: Record<string, unknown>,
  unfinishedActions: boolean,
): Record<string, unknown> {
  const execution = ceiling.execution;
  if (
    unfinishedActions ||
    !execution ||
    typeof execution !== 'object' ||
    Array.isArray(execution) ||
    !Object.hasOwn(execution, 'principalId')
  )
    return ceiling;
  const { principalId: _principal, ...rest } = execution as Record<
    string,
    unknown
  >;
  return { ...ceiling, execution: rest };
}
