/**
 * Strict JSON helpers shared by every desktop contract artifact.
 *
 * `JSON.parse` silently keeps the last of several duplicate keys, so each
 * parser first checks for duplicates, then closes the schema with an explicit
 * key list. None of these helpers echo any part of the input.
 */

/**
 * Report whether any JSON object in valid JSON text repeats a key, at any
 * depth, comparing keys after unescaping. The text must already be valid JSON
 * (call `JSON.parse` first). Only string tokens in key position are examined.
 */
export function hasDuplicateKeys(json: string): boolean {
  const frames: { keys: Set<string> | null; expectKey: boolean }[] = [];
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (char === '"') {
      let end = i + 1;
      while (json[end] !== '"') end += json[end] === '\\' ? 2 : 1;
      const frame = frames[frames.length - 1];
      if (frame?.keys && frame.expectKey) {
        const key: string = JSON.parse(json.slice(i, end + 1));
        if (frame.keys.has(key)) return true;
        frame.keys.add(key);
        frame.expectKey = false;
      }
      i = end;
    } else if (char === '{') {
      frames.push({ keys: new Set(), expectKey: true });
    } else if (char === '[') {
      frames.push({ keys: null, expectKey: false });
    } else if (char === '}' || char === ']') {
      frames.pop();
    } else if (char === ',') {
      const frame = frames[frames.length - 1];
      if (frame?.keys) frame.expectKey = true;
    }
  }
  return false;
}

export type StrictJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: 'syntax' | 'duplicate_keys' };

/** Parse JSON text, rejecting syntax errors and duplicate keys. */
export function parseStrictJson(json: string): StrictJsonResult {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'syntax' };
  }
  if (hasDuplicateKeys(json)) return { ok: false, reason: 'duplicate_keys' };
  return { ok: true, value };
}

/** True for a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * True if `record` has every `required` key and no keys outside
 * `required` plus `optional`. Uses own keys only.
 */
export function hasClosedKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set<string>([...required, ...optional]);
  return (
    Object.keys(record).every((key) => allowed.has(key)) &&
    required.every((key) => Object.hasOwn(record, key))
  );
}
