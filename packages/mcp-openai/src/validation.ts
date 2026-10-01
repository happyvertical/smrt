/** No transport or host imports: shared bounded, inert wire validation. */
export const OPENAI_EXTENSIONS_REVISION =
  'e314720a0daac326217d1f123fcf51647868fa9f';
export function json(value: unknown): void {
  let remaining = 65536;
  const visit = (v: unknown, depth: number): void => {
    if (--remaining < 0 || depth > 16)
      throw new TypeError('Metadata exceeds limits');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v === 'string') {
      remaining -= new TextEncoder().encode(v).length;
      if (remaining < 0) throw new TypeError('Metadata exceeds limits');
      return;
    }
    if (Array.isArray(v)) {
      if (v.length > 1024) throw new TypeError('Array exceeds limits');
      for (const item of v) visit(item, depth + 1);
      return;
    }
    const obj = record(v);
    const keys = Object.keys(obj);
    if (keys.length > 256) throw new TypeError('Object exceeds limits');
    for (const key of keys) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new TypeError('Unsafe key');
      const descriptor = Object.getOwnPropertyDescriptor(obj, key);
      if (!descriptor || !('value' in descriptor))
        throw new TypeError('Expected inert JSON');
      visit(key, depth + 1);
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
}
export function record(v: unknown): Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(v))
  )
    throw new TypeError('Expected plain object');
  return v as Record<string, unknown>;
}
export function text(v: unknown, max = 4096): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new TypeError('Expected bounded nonblank string');
  return v;
}
export function keys(
  v: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(v).some((key) => !allowed.includes(key)))
    throw new TypeError('Unknown field');
}
export function toolName(v: unknown): string {
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(text(v, 128)))
    throw new TypeError('Expected canonical tool name');
  return v as string;
}
export type OpenAiDisplayMode = 'inline' | 'fullscreen';
export function displayMode(v: unknown): OpenAiDisplayMode {
  if (v !== 'inline' && v !== 'fullscreen')
    throw new TypeError('Unsupported OpenAI display mode');
  return v;
}
/** Reject alternate-origin and ambiguous paths before routing or generating a link. */
export function appRelativeUrl(value: unknown): string {
  const url = text(value, 2048);
  if (
    !url.startsWith('/') ||
    url.startsWith('//') ||
    /[\\#]/.test(url) ||
    [...url].some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new TypeError('Invalid app-relative URL');
  let decoded: string;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    throw new TypeError('Invalid URL encoding');
  }
  if (
    /[\\#]/.test(decoded) ||
    [...decoded].some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
    ) ||
    decoded.startsWith('//') ||
    /%[0-9a-f]{2}/i.test(decoded)
  )
    throw new TypeError('Ambiguous app-relative URL');
  const pathname = decodeURIComponent(url.split('?')[0]);
  if (pathname.split('/').some((part) => part === '.' || part === '..'))
    throw new TypeError('Path traversal');
  if (new URL(url, 'https://app.invalid').origin !== 'https://app.invalid')
    throw new TypeError('External URL');
  return url;
}
