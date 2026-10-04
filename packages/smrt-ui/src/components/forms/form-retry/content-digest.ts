/**
 * The `runOnce()` content digest, computed in the browser (#3291).
 *
 * `runOnce()` (`@happyvertical/smrt-core`, `src/run-once.ts`) digests the
 * submitted content itself on the server, so pairing a form with it does NOT
 * need this function: send the submission key, pass the action's `FormData`
 * as `content`, and the server derives the claim. This exists for the cases
 * where the browser needs the SAME digest the server will compute — to tell a
 * person whether the retry they are about to send is byte-identical to the
 * submit that may already be recorded, to key a client-side record of an
 * attempt, or to log a correlatable identity without logging the content.
 *
 * It is a byte-for-byte port of core's `digestRunOnceContent()`, using Web
 * Crypto (`crypto.subtle`) instead of `node:crypto`; shared test vectors in
 * both packages hold the two together. The algorithm:
 *
 * - Content is normalized once, following JSON serialization exactly:
 *   `toJSON(key)` is called with the property name or array index (a `Date`
 *   digests as its ISO string), and `undefined`, function and symbol values
 *   are omitted from objects and written as `null` in arrays.
 * - A `FormData` digests as its ORDERED entry list — repeated fields and their
 *   order are significant — because JSON would reduce every form to `{}` and
 *   collapse distinct submissions (#3136). A `File`/`Blob` entry digests by
 *   `{ name, size, type }`, never its bytes: re-choosing the same file after a
 *   reload reproduces the digest, and a different file of the same name, size
 *   and type does too.
 * - Content containing a `FormData` is hashed in a separate domain (the input
 *   is prefixed with a byte sorted-key JSON never starts with, and user keys
 *   starting with NUL are escaped), so no plain object can forge it.
 * - `Map`, `Set`, `RegExp`, any other non-plain object without `toJSON()`, and
 *   `bigint` are rejected with a `TypeError` rather than hashed as `{}`.
 * - The digest is the lowercase hex sha256 of the sorted-key JSON encoding.
 *
 * `crypto.subtle` exists only in secure contexts (HTTPS, `localhost`); the
 * function rejects with a clear error elsewhere.
 *
 * @module
 */

const FORM_DATA_TAG = '\u0000FormData';
const FORM_DATA_DOMAIN = '\u0001run-once-formdata-v1\n';

class NormalizedFormData {
  constructor(readonly entries: Array<[string, unknown]>) {}
}

const OMIT: unique symbol = Symbol('form-retry-digest-omit');

interface NormalizeState {
  sawFormData: boolean;
}

function normalize(
  input: unknown,
  state: NormalizeState,
  key: string,
): unknown {
  let value = input;
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'bigint') &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  ) {
    value = (value as { toJSON: (key: string) => unknown }).toJSON(key);
  }
  if (value === null) return null;
  switch (typeof value) {
    case 'undefined':
    case 'function':
    case 'symbol':
      return OMIT;
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      throw new TypeError(
        'submission content cannot contain a bigint; pass plain JSON data',
      );
  }
  if (typeof FormData !== 'undefined' && value instanceof FormData) {
    state.sawFormData = true;
    const entries: Array<[string, unknown]> = [];
    value.forEach((entry, name) => {
      entries.push([name, normalize(entry, state, name)]);
    });
    return new NormalizedFormData(entries);
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return {
      name: (value as Blob & { name?: string }).name ?? null,
      size: value.size,
      type: value.type,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const normalized = normalize(item, state, String(index));
      return normalized === OMIT ? null : normalized;
    });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    const name =
      (value as { constructor?: { name?: string } }).constructor?.name ||
      'non-plain object';
    throw new TypeError(
      `submission content cannot contain a ${name}; convert it to plain JSON data`,
    );
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [member, memberValue] of Object.entries(value as object)) {
    const normalized = normalize(memberValue, state, member);
    if (normalized !== OMIT) result[member] = normalized;
  }
  return result;
}

function toFormDataDomain(value: unknown): unknown {
  if (value instanceof NormalizedFormData) {
    return {
      [FORM_DATA_TAG]: value.entries.map(([key, entry]) => [
        key,
        toFormDataDomain(entry),
      ]),
    };
  }
  if (Array.isArray(value)) return value.map(toFormDataDomain);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, member] of Object.entries(value)) {
      result[key.startsWith('\u0000') ? `\u0000${key}` : key] =
        toFormDataDomain(member);
    }
    return result;
  }
  return value;
}

/** Sorted-key JSON, identical to `@happyvertical/smrt-scanner`'s `stableStringify`. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * The exact string `runOnce()` hashes for `content`.
 * @throws {TypeError} when `content` contains a value with no faithful JSON form.
 * @internal
 */
export function submissionDigestInput(content: unknown): string {
  const state: NormalizeState = { sawFormData: false };
  const captured = normalize(content, state, '');
  const normalized = captured === OMIT ? null : captured;
  return state.sawFormData
    ? FORM_DATA_DOMAIN + JSON.stringify(sortValue(toFormDataDomain(normalized)))
    : JSON.stringify(sortValue(normalized));
}

/**
 * The content digest `runOnce()` will compute on the server for `content`:
 * lowercase hex sha256. See the module doc for what is and is not digested
 * (a `File` by name, size and type — never its bytes).
 *
 * @throws {TypeError} (as a rejection) when `content` has no faithful JSON
 *   form, or when Web Crypto is unavailable (not a secure context).
 */
export async function digestSubmissionContent(
  content: unknown,
): Promise<string> {
  const input = submissionDigestInput(content);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new TypeError(
      'digestSubmissionContent needs Web Crypto (crypto.subtle), which browsers expose only in secure contexts (HTTPS or localhost)',
    );
  }
  const bytes = new TextEncoder().encode(input);
  const hash = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
