import type { ControlOption } from './control-interaction.js';

export function booleanControlValue(next: unknown): boolean {
  return typeof next === 'string'
    ? ['true', '1', 'yes', 'on'].includes(next.toLowerCase())
    : Boolean(next);
}

export function validateNativeCheckedValue(
  element: HTMLInputElement,
  next: unknown,
): boolean {
  const candidate = element.cloneNode() as HTMLInputElement;
  candidate.checked = booleanControlValue(next);
  return candidate.checkValidity();
}

export function validateNativeTextValue(
  element: HTMLTextAreaElement,
  next: unknown,
): boolean {
  const candidate = element.cloneNode() as HTMLTextAreaElement;
  candidate.value = String(next ?? '');
  if (candidate.required && candidate.value.length === 0) return false;
  if (candidate.minLength >= 0 && candidate.value.length < candidate.minLength)
    return false;
  if (candidate.maxLength >= 0 && candidate.value.length > candidate.maxLength)
    return false;
  return candidate.checkValidity();
}

export function matchingOption(
  options: ControlOption[],
  next: unknown,
  matchLabel = false,
): ControlOption | undefined {
  const candidate = String(next ?? '');
  return options.find(
    (option) =>
      String(option.value) === candidate ||
      (matchLabel && option.label === candidate),
  );
}

export function validatesEnabledOption(
  options: ControlOption[],
  next: unknown,
  matchLabel = false,
): boolean {
  const option = matchingOption(options, next, matchLabel);
  return option !== undefined && option.disabled !== true;
}

export function validatesEnabledOptions(
  options: ControlOption[],
  next: unknown,
): boolean {
  if (!Array.isArray(next)) return false;
  const matched = next.map((candidate) => matchingOption(options, candidate));
  return (
    matched.every((option) => option !== undefined && !option.disabled) &&
    new Set(matched.map((option) => String(option?.value))).size === next.length
  );
}

export function numberMatchesStep(
  value: number,
  min: number,
  step: number,
): boolean {
  if (!Number.isFinite(step) || step <= 0) return true;
  const offset = (value - min) / step;
  return Math.abs(offset - Math.round(offset)) <= 1e-9;
}

export function validatesSteppedNumber(
  next: unknown,
  min: number,
  max: number,
  step: number,
): boolean {
  let value: number;
  try {
    value = typeof next === 'number' ? next : Number(next);
  } catch {
    return false;
  }
  return (
    Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    numberMatchesStep(value, min, step)
  );
}

export function snapSteppedNumber(
  next: number,
  min: number,
  max: number,
  step: number,
): number {
  if (!Number.isFinite(step) || step <= 0) {
    return Math.min(max, Math.max(min, next));
  }
  const snapped = min + Math.round((next - min) / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

export function validatesStringArray(
  next: unknown,
  maxItems: number | undefined,
  allowDuplicates: boolean,
): boolean {
  if (!Array.isArray(next) || !next.every((item) => typeof item === 'string'))
    return false;
  if (maxItems !== undefined && next.length > maxItems) return false;
  return allowDuplicates || new Set(next).size === next.length;
}
