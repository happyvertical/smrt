/**
 * Resolve the closed set of allowed values of a field's declared type (#3598).
 *
 * The scanner records annotations as strings and keeps a project-wide
 * `typeAliases` map (`type X = 'a' | 'b'` and `enum X { A = 'a' }` both land
 * there as the union string `'a' | 'b'`). This module walks such a string:
 * splits the top-level union, follows alias identifiers (so a union that
 * *contains* an alias is flattened rather than treated as opaque), drops
 * `null` / `undefined`, and returns the literal values in declaration order.
 *
 * It answers `undefined` unless EVERY non-nullish member resolves to a string
 * or number literal. A union that also admits `string` / `number` / an object
 * type is not a closed set, so no `enum` is emitted for it.
 */

/** A value an enum-typed field may hold. */
export type EnumValue = string | number;

/** Alias recursion bound; matches the adapter's circular-alias guard. */
const MAX_ALIAS_DEPTH = 8;

/** Split a union string on `|` outside quotes. */
function splitUnion(type: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of type) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === '|') {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts.filter((part) => part !== '');
}

function resolveMember(
  member: string,
  aliases: Record<string, string>,
  depth: number,
  out: EnumValue[],
): boolean {
  const quoted = member.match(/^(['"])(.*)\1$/s);
  if (quoted) {
    out.push(quoted[2]);
    return true;
  }
  if (/^-?\d+(\.\d+)?$/.test(member)) {
    out.push(Number(member));
    return true;
  }
  if (member === 'null' || member === 'undefined') return true;
  if (
    depth < MAX_ALIAS_DEPTH &&
    /^[A-Za-z_$][\w$]*$/.test(member) &&
    Object.hasOwn(aliases, member)
  ) {
    const nested = collect(aliases[member], aliases, depth + 1);
    if (!nested) return false;
    out.push(...nested);
    return true;
  }
  return false;
}

function collect(
  type: string,
  aliases: Record<string, string>,
  depth: number,
): EnumValue[] | undefined {
  const out: EnumValue[] = [];
  for (const member of splitUnion(type)) {
    if (!resolveMember(member, aliases, depth, out)) return undefined;
  }
  return out;
}

/**
 * Allowed values for a declared type string, or `undefined` when the type is
 * not a closed literal set. Order is declaration order; duplicates (from a
 * union that re-lists an aliased member) are dropped, keeping the first.
 */
export function resolveEnumValues(
  type: string | null | undefined,
  aliases: Record<string, string> = {},
): EnumValue[] | undefined {
  if (!type) return undefined;
  const values = collect(type.trim(), aliases, 0);
  if (!values || values.length === 0) return undefined;
  const seen = new Set<EnumValue>();
  const unique: EnumValue[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}
