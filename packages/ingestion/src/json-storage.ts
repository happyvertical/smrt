/** PostgreSQL JSONB rejects NUL and unpaired UTF-16 surrogates. Keep the same
 * storage contract on SQLite; never replace or reinterpret provider content. */
export function storableText(value: string): boolean {
  if (value.includes('\u0000')) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Validate decoded JSON keys and string values after the caller's byte ceiling.
 * Inspecting serialization escapes with a regex would confuse literal backslash-u
 * text with a decoded control character. Parsing is bounded by that byte ceiling;
 * a parser-depth refusal is malformed output too. */
export function storableJSONText(serialized: string): boolean {
  let valid = true;
  try {
    JSON.parse(serialized, (key: string, value: unknown) => {
      if (
        !storableText(key) ||
        (typeof value === 'string' && !storableText(value))
      )
        valid = false;
      return value;
    });
  } catch {
    return false;
  }
  return valid;
}
