/**
 * Structural equality for JSON field values (#4604).
 *
 * Diff guards (`SmrtCollection.getOrUpsert()` / `getDiff()`, sync-apply
 * no-op detection) must not report an unchanged JSON field as changed just
 * because the incoming object or array is a different instance, or because
 * its keys arrive in a different order than the stored row's. Doing so
 * re-saves the row, moves `updated_at`, and appends a change-feed entry on
 * every call.
 *
 * Equality is decided in the value's JSON (persisted) form:
 * - plain objects compare key-order-insensitively; a key whose value is
 *   `undefined` is absent (JSON drops it), but `null` is a real value;
 * - arrays compare element by element, in order;
 * - a `Date` equals another `Date` at the same instant, or the ISO string
 *   `JSON.stringify` would write for it;
 * - everything else compares with `===` (no numeric/string coercion).
 *
 * Errs toward "changed": anything it cannot prove equal is unequal.
 */

// Import-free on purpose: generated sync-apply routes bundle this module.

const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * Whether every number literal in JSON text survives `JSON.parse` exactly.
 *
 * `JSON.parse` reads numbers as doubles, so `9007199254740993` and
 * `9007199254740992` parse to the same value. A literal is exact when the
 * double it parses to prints back as the same text; anything else (unsafe
 * integers, more digits than a double holds, `1.0`, `1e2`) makes the text
 * unprovable. Digits inside JSON strings are not numbers and are skipped.
 */
export function jsonNumbersRoundTrip(text: string): boolean {
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      JSON_NUMBER.lastIndex = index;
      const match = JSON_NUMBER.exec(text);
      if (!match) return false;
      const literal = match[0];
      if (JSON.stringify(Number(literal)) !== literal) return false;
      index += literal.length - 1;
    }
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function dateTime(value: Date): number | null {
  const time = value.getTime();
  return Number.isNaN(time) ? null : time;
}

function definedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

/**
 * Whether two values are equal in their JSON form.
 *
 * Bounded by `depth` so a cyclic value (which cannot be persisted as JSON)
 * reports unequal instead of overflowing the stack.
 */
export function jsonValuesEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (depth > 256) return false;

  if (a instanceof Date || b instanceof Date) {
    if (a instanceof Date && b instanceof Date) {
      const timeA = dateTime(a);
      return timeA !== null && timeA === dateTime(b);
    }
    const [date, other] = a instanceof Date ? [a, b] : [b as Date, a];
    return (
      typeof other === 'string' &&
      dateTime(date) !== null &&
      date.toISOString() === other
    );
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    // Index loop, not `every()`: `every()` skips holes, so a sparse array
    // would match any value at that index.
    for (let index = 0; index < a.length; index += 1) {
      if (!jsonValuesEqual(a[index], b[index], depth + 1)) return false;
    }
    return true;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = definedKeys(a);
    const keysB = definedKeys(b);
    if (keysA.length !== keysB.length) return false;
    // Own properties only: `b[key]` alone would resolve `__proto__` (an own
    // key of parsed JSON) through the prototype chain.
    return keysA.every(
      (key) =>
        Object.hasOwn(b, key) &&
        b[key] !== undefined &&
        jsonValuesEqual(a[key], b[key], depth + 1),
    );
  }

  return false;
}

/**
 * Parse `value` when it is JSON text for an object or array; otherwise
 * return it unchanged. Used to compare a JSON field hydrated (or supplied)
 * as text against the same value supplied as an object.
 */
export function parseJsonContainerText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  // Text whose numbers a double cannot hold exactly stays unparsed (unequal).
  if (!jsonNumbersRoundTrip(trimmed)) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' ? parsed : value;
  } catch {
    return value;
  }
}
