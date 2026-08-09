/**
 * Browser-safe usage capture primitives for the field-policy learning loop.
 *
 * Hosts own the authenticated transport. This module deliberately carries no
 * tenant, user, permission, or field-sensitivity information: the server
 * derives all of that from its ambient context and live object registry.
 */
/** One submitted field value sent to the host's usage transport. */
export interface FieldUsageEntry {
  objectRef: string;
  fieldName: string;
  value?: unknown;
  /** Optional value-less hint; normal ObjectForm capture sends the value. */
  matchedDefault?: boolean;
}

/** Resolved default metadata used only for a value-less count signal. */
export interface FieldUsageDefault {
  hasDefault: boolean;
  defaultValue: unknown;
}

/**
 * Structural host transport for the counters collection's batched action.
 * A reporter must never be allowed to affect a successful form submission.
 */
export interface FieldUsageReporter {
  reportUsage(input: { entries: readonly FieldUsageEntry[] }): unknown;
}

export interface CollectFieldUsageEntriesOptions {
  objectRef: string;
  values: Readonly<Record<string, unknown>>;
  /**
   * Rendered field names and their persisted browser wire type. The type is
   * used only to minimize value transit — it is never a sensitivity or
   * authorization decision.
   */
  fields?: Readonly<Record<string, FieldUsageWireType>>;
  /**
   * Resolved defaults for rendered fields. For count-only values, a matching
   * default is sent as a positive hint so the server does not treat it as a
   * deviation. Absent or non-matching defaults deliberately send no hint.
   */
  defaults?: Readonly<Record<string, FieldUsageDefault>>;
}

export type FieldUsageWireType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'json'
  | 'foreignKey'
  | 'crossPackageRef';

/** Values may transit only for bounded, identifier-like wire types. */
export function canCaptureFieldUsageValue(
  type: FieldUsageWireType | undefined,
): boolean {
  return (
    type === 'boolean' || type === 'foreignKey' || type === 'crossPackageRef'
  );
}

/**
 * Collect every non-blank submitted field, including values matching a
 * resolved default. Values transit only for bounded boolean/reference fields;
 * free text, numbers, dates, and JSON emit count-only signals. Capturing only
 * deviations would make the default's dominance denominator disappear. The
 * server still derives eligibility, sensitivity, and every aggregate.
 */
export function collectFieldUsageEntries(
  options: CollectFieldUsageEntriesOptions,
): FieldUsageEntry[] {
  const fields =
    options.fields ??
    Object.fromEntries(
      Object.keys(options.values).map((fieldName) => [fieldName, undefined]),
    );
  const entries: FieldUsageEntry[] = [];
  for (const [fieldName, type] of Object.entries(fields)) {
    const value = options.values[fieldName];
    if (isBlankFieldValue(value)) continue;
    if (canCaptureFieldUsageValue(type)) {
      entries.push({ objectRef: options.objectRef, fieldName, value });
      continue;
    }
    const fieldDefault = options.defaults?.[fieldName];
    entries.push({
      objectRef: options.objectRef,
      fieldName,
      ...(fieldDefault?.hasDefault &&
      fieldUsageValuesEqual(value, fieldDefault.defaultValue)
        ? { matchedDefault: true }
        : {}),
    });
  }
  return entries;
}

/** Zero and false are submissions; only absent/null/empty-string values are not. */
export function isBlankFieldValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** JSON-safe equality for the count-only default-match hint. */
export function fieldUsageValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/** Fire-and-forget by design: metrics transport failures never reject submit. */
export function reportFieldUsage(
  reporter: FieldUsageReporter | undefined,
  entries: readonly FieldUsageEntry[],
): void {
  if (!reporter || entries.length === 0) return;
  try {
    void Promise.resolve(reporter.reportUsage({ entries })).catch(
      () => undefined,
    );
  } catch {
    // A synchronous host adapter failure is non-fatal by the same contract.
  }
}
