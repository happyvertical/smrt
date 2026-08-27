import type { ControlOption } from './control-interaction.js';

export function booleanControlValue(next: unknown): boolean {
  return typeof next === 'string'
    ? ['true', '1', 'yes', 'on'].includes(next.toLowerCase())
    : Boolean(next);
}

export function prepareBooleanControlValue(next: unknown): unknown {
  if (typeof next === 'boolean') return next;
  if (next !== null && typeof next === 'object') {
    throw new Error('staged_value_invalid');
  }
  return next;
}

export function prepareTextControlValue(next: unknown): unknown {
  if (next === null || next === undefined) return next;
  if (
    typeof next === 'string' ||
    typeof next === 'number' ||
    typeof next === 'boolean'
  ) {
    return String(next);
  }
  throw new Error('staged_value_invalid');
}

export function prepareNumberControlValue(next: unknown): unknown {
  if (next === '' || next === null || next === undefined) return '';
  if (typeof next !== 'string' && typeof next !== 'number') {
    throw new Error('staged_value_invalid');
  }
  const value = Number(next);
  return Number.isFinite(value) ? value : next;
}

export function prepareEnabledOptionValue(
  options: ControlOption[],
  next: unknown,
  matchLabel = false,
): unknown {
  const option = matchingOption(options, next, matchLabel);
  return option?.value ?? next;
}

export function prepareEnabledOptionValues(
  options: ControlOption[],
  next: unknown,
): unknown {
  return normalizeEnabledOptions(options, next) ?? next;
}

export function validateNativeCheckedValue(
  element: HTMLInputElement,
  next: unknown,
): boolean {
  if (typeof next !== 'boolean') return false;
  const candidate = element.cloneNode() as HTMLInputElement;
  candidate.checked = next;
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
  return (
    options.find((option) => Object.is(option.value, next)) ??
    options.find(
      (option) =>
        String(option.value) === candidate ||
        (matchLabel && option.label === candidate),
    )
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
  return normalizeEnabledOptions(options, next) !== undefined;
}

export function normalizeEnabledOptions(
  options: ControlOption[],
  next: unknown,
): Array<string | number> | undefined {
  return normalizeOptionValues(options, next, false, false);
}

export function normalizeCurrentOptionValues(
  options: ControlOption[],
  next: unknown,
): Array<string | number> {
  return normalizeOptionValues(options, next, true, true) ?? [];
}

function normalizeOptionValues(
  options: ControlOption[],
  next: unknown,
  allowDisabled: boolean,
  skipInvalid: boolean,
): Array<string | number> | undefined {
  if (!Array.isArray(next)) return undefined;
  const matchedIndexes = new Set<number>();
  const normalized: Array<string | number> = [];
  for (const candidate of next) {
    if (typeof candidate !== 'string' && typeof candidate !== 'number')
      return undefined;
    let index = options.findIndex((option) =>
      Object.is(option.value, candidate),
    );
    if (index < 0) {
      index = options.findIndex(
        (option) => String(option.value) === String(candidate),
      );
    }
    const option = options[index];
    const invalid =
      !option ||
      (!allowDisabled && option.disabled) ||
      matchedIndexes.has(index);
    if (invalid) {
      if (skipInvalid) continue;
      return undefined;
    }
    matchedIndexes.add(index);
    normalized.push(option.value);
  }
  return normalized;
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
  const precision = Math.max(
    decimalPlaces(min),
    decimalPlaces(max),
    decimalPlaces(step),
  );
  const stable =
    precision <= 100
      ? Number(snapped.toFixed(precision))
      : Number(
          snapped.toPrecision(
            Math.min(
              100,
              Math.max(
                significantDigits(min),
                significantDigits(max),
                significantDigits(step),
              ),
            ),
          ),
        );
  return Math.min(max, Math.max(min, stable));
}

function significantDigits(value: number): number {
  const coefficient = String(Math.abs(value)).toLowerCase().split('e')[0] ?? '';
  const digits = coefficient.replace('.', '').replace(/^0+/, '');
  return Math.max(1, digits.length);
}

function decimalPlaces(value: number): number {
  const [coefficient = '', exponentText = '0'] = String(value)
    .toLowerCase()
    .split('e');
  const fractionLength = coefficient.split('.')[1]?.length ?? 0;
  const exponent = Number(exponentText);
  return Math.max(
    0,
    fractionLength - (Number.isFinite(exponent) ? exponent : 0),
  );
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
