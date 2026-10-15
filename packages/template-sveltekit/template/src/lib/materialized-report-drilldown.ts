import type { MaterializedReportDrilldownPresentation } from '@happyvertical/smrt-reports';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const nonemptyText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const optionalText = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || typeof value === 'string';

const minor = (value: unknown): value is number | null | undefined =>
  value === undefined || value === null || Number.isSafeInteger(value);

/** Validate the versioned host payload before it reaches the generic UI. */
export function parseMaterializedReportDrilldown(
  value: unknown,
): MaterializedReportDrilldownPresentation | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.selectedMeasure))
    return undefined;
  if (
    !nonemptyText(value.selectedMeasure.id) ||
    !nonemptyText(value.selectedMeasure.label) ||
    !nonemptyText(value.currency) ||
    !Array.isArray(value.contributors) ||
    !Array.isArray(value.warnings) ||
    typeof value.complete !== 'boolean'
  )
    return undefined;
  if (!/^[A-Za-z]{3}$/.test(value.currency)) return undefined;
  for (const contributor of value.contributors) {
    if (!isRecord(contributor) || !isRecord(contributor.values)) return undefined;
    if (
      !nonemptyText(contributor.id) ||
      !nonemptyText(contributor.source) ||
      !nonemptyText(contributor.identity) ||
      !optionalText(contributor.date) ||
      !optionalText(contributor.party) ||
      !minor(contributor.values.valueMinor) ||
      !minor(contributor.values.taxableMinor) ||
      !minor(contributor.values.taxMinor)
    )
      return undefined;
  }
  for (const warning of value.warnings) {
    if (
      !isRecord(warning) ||
      !nonemptyText(warning.code) ||
      !nonemptyText(warning.message) ||
      (warning.kind !== 'incomplete' && warning.kind !== 'drift')
    )
      return undefined;
  }
  return value as unknown as MaterializedReportDrilldownPresentation;
}
