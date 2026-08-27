/** Canonicalize scalar values before they enter staged rich-field review. */
export function prepareTextFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  throw new Error('staged_value_invalid');
}

/** Reject values which a rich field cannot synchronously canonicalize. */
export function invalidStagedValue(): never {
  throw new Error('staged_value_invalid');
}
