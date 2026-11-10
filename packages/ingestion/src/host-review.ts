import type { IntakeValues } from './execution-dto.js';
import type { HostSuggestionReview } from './proposal-dto.js';

/** At most this many reason codes per suggestion. */
export const HOST_REVIEW_MAX_REASONS = 8;
/** A reason code: lowercase, starts with a letter, bounded; no spaces or punctuation beyond `_ . -`. */
export const HOST_REVIEW_REASON_PATTERN = /^[a-z][a-z0-9_.-]{0,47}$/;
/** Codes the service itself records when the hook fails; hosts may not need to emit them. */
export const HOST_REVIEW_FAILED = 'host_review_failed';
export const HOST_REVIEW_INVALID = 'host_review_invalid';

/**
 * Normalize a host `reviewSuggestion` result into the stored, value-free shape.
 * Throws on anything unexpected so the caller can hold the suggestion: only
 * `{hold?, reasons?, prefilled?}` is accepted, `prefilled` entries must be the
 * handler's declared argument names, reasons are bounded codes, and a reason
 * that contains one of the suggestion's own argument values is refused.
 * Returns undefined when the host recorded nothing.
 */
export function normalizeHostReview(
  result: unknown,
  argsSchema: IntakeValues,
  args: IntakeValues,
): HostSuggestionReview | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result !== 'object' || Array.isArray(result))
    throw new Error('Invalid host review');
  const input = result as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!['hold', 'reasons', 'prefilled'].includes(key))
      throw new Error('Invalid host review');
  if (input.hold !== undefined && typeof input.hold !== 'boolean')
    throw new Error('Invalid host review');
  const properties =
    argsSchema.properties &&
    typeof argsSchema.properties === 'object' &&
    !Array.isArray(argsSchema.properties)
      ? Object.keys(argsSchema.properties)
      : [];
  const list = (value: unknown, limit: number): string[] => {
    if (value === undefined) return [];
    if (
      !Array.isArray(value) ||
      value.length > limit ||
      value.some((entry) => typeof entry !== 'string')
    )
      throw new Error('Invalid host review');
    return [...new Set(value as string[])];
  };
  const reasons = list(input.reasons, HOST_REVIEW_MAX_REASONS);
  const prefilled = list(input.prefilled, Math.max(properties.length, 1));
  if (reasons.some((code) => !HOST_REVIEW_REASON_PATTERN.test(code)))
    throw new Error('Invalid host review');
  if (prefilled.some((field) => !properties.includes(field)))
    throw new Error('Invalid host review');
  const values: string[] = [];
  const collect = (value: unknown, depth = 0) => {
    if (depth > 6) return;
    if (typeof value === 'string') values.push(value.toLowerCase());
    else if (typeof value === 'number') values.push(String(value));
    else if (Array.isArray(value)) for (const e of value) collect(e, depth + 1);
    else if (value && typeof value === 'object')
      for (const e of Object.values(value)) collect(e, depth + 1);
  };
  collect(args);
  if (
    reasons.some((code) =>
      values.some((value) => value.length >= 3 && code.includes(value)),
    )
  )
    throw new Error('Invalid host review');
  const held = input.hold === true;
  if (!held && !reasons.length && !prefilled.length) return undefined;
  return { held, reasons, prefilled };
}
