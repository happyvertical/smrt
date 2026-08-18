/**
 * Index-rendering helpers shared across DDL strategies, schema aggregator,
 * and the migration generator/differ.
 *
 * IMPORTANT: this module must remain a pure utility with **type-only
 * imports** to avoid introducing a cycle with `registry.ts` /
 * `collection.ts`. Don't add runtime imports that pull SmrtClass /
 * SmrtCollection / ObjectRegistry through here.
 */

import type { DatabaseEngine } from './ddl/types.js';
import {
  isSafeIdentifier,
  isSafeIdentifierPath,
  quoteIdentifier,
  quoteStringLiteral,
} from './sql-identifiers.js';
import type { IndexDefinition } from './types.js';

/**
 * Render the SQL target of a CREATE INDEX statement.
 *
 * For ordinary indexes this is a comma-separated, double-quoted column list.
 * For JSON-path indexes (introduced by `@meta({ indexed: true })`) it is the
 * dialect-specific expression that points into a JSONB column.
 *
 * @param index - The index definition (may carry `jsonPath`)
 * @param engine - The target database dialect
 * @returns The contents of the trailing `(...)` of the CREATE INDEX statement
 */
export function renderIndexTarget(
  index: Pick<IndexDefinition, 'columns' | 'jsonPath'>,
  engine: DatabaseEngine,
): string {
  if (index.jsonPath?.column && index.jsonPath.path) {
    const col = index.jsonPath.column;
    const path = index.jsonPath.path;
    // The column is interpolated as an identifier and the path as a SQL string
    // literal. Validate both against an identifier allowlist (these are
    // developer-controlled `@meta` field names) so a malformed name can't
    // smuggle structure into the expression even after escaping.
    if (!isSafeIdentifier(col)) {
      throw new Error(
        `[index-utils] Unsafe JSON-path index column "${col}": must be a simple identifier`,
      );
    }
    if (!isSafeIdentifierPath(path)) {
      throw new Error(
        `[index-utils] Unsafe JSON-path index path "${path}": must be a simple (dotted) identifier`,
      );
    }
    if (engine === 'sqlite') {
      // SQLite's json_extract is a function call — no extra wrapping needed.
      return `json_extract(${quoteIdentifier(col)}, ${quoteStringLiteral(
        `$.${path}`,
      )})`;
    }
    // Postgres / DuckDB JSON path access via `->>`. PostgreSQL requires
    // operator expressions in index elements to be parenthesized — the
    // outer `()` in `CREATE INDEX ... ON tbl (...)` is the column list, so
    // the expression itself needs its own parens. Returning the wrapped
    // form here keeps the rule local to this helper and works on DuckDB
    // (extra parens are harmless).
    return `(${quoteIdentifier(col)}->>${quoteStringLiteral(path)})`;
  }
  return (index.columns ?? []).map((c) => quoteIdentifier(c)).join(', ');
}

/**
 * True if the index has a valid jsonPath target.
 */
export function isJsonPathIndex(
  index: Pick<IndexDefinition, 'jsonPath'>,
): boolean {
  return !!(index.jsonPath?.column && index.jsonPath.path);
}

/**
 * True for a UNIQUE index whose predicate scopes it to one STI subtype
 * (`WHERE _meta_type = '<qualified class>'`) — the shape `SchemaGenerator`
 * emits for `@field({ unique: true })` declared only on an STI descendant
 * (#2359).
 *
 * Engines without partial indexes (DuckDB, and the JSON adapter it backs)
 * degrade an ordinary partial index to a full index, and a caller-declared
 * partial UNIQUE (`WHERE active = TRUE`) to a full UNIQUE — a stricter but
 * intended approximation. This shape is the exception: widening it would
 * enforce one subtype's uniqueness across every sibling's rows in the shared
 * table, so those engines skip it instead. Kept here so the DDL strategy and
 * the migration differ apply the same test.
 */
export function isStiSubtypeUniqueIndex(
  index: Pick<IndexDefinition, 'unique' | 'where'>,
): boolean {
  return (
    index.unique === true &&
    typeof index.where === 'string' &&
    /^\s*\(*\s*_meta_type\s*(::\w+\s*)?=/.test(index.where)
  );
}

/**
 * The strictest identifier length any SMRT-supported engine imposes: 63 bytes.
 *
 * PostgreSQL compiles with `NAMEDATALEN = 64`, so every table, column, index,
 * constraint and trigger name is silently truncated to 63 **bytes** (not
 * characters — the limit is on the UTF-8 encoding). SQLite and DuckDB have no
 * practical limit, which is exactly why the overflow went unnoticed: a name
 * that works in every test truncates in production (#2374, finding C5).
 *
 * Silent truncation is not merely cosmetic. `CREATE INDEX IF NOT EXISTS` on a
 * name whose first 63 bytes match an existing index is a no-op, so a second
 * index that differs only past byte 63 is never created; the migration differ
 * then finds it missing on every run and emits `add_index` forever. The shipped
 * `content_contribution_revisions_contribution_id_revision_number_idx` (66
 * bytes) is the concrete case — only the differ's signature-equivalence check
 * kept it from looping.
 */
export const MAX_IDENTIFIER_BYTES = 63;

/**
 * Hex digits of the disambiguating digest appended to a shortened identifier.
 *
 * 40 bits. The digest exists to keep two names that share a long prefix apart,
 * so its only job is collision resistance across the handful of over-length
 * identifiers a schema produces; {@link enforceIdentifierLimits} additionally
 * fails loudly if two names on one table ever do collide, so a residual
 * collision can never reproduce the silent-no-op bug this guard fixes.
 */
const IDENTIFIER_DIGEST_HEX = 10;

/**
 * Trailing tokens preserved across shortening so a shortened name still reads
 * as what it is (`..._idx` stays an index) and so suffix-based filters — the
 * differ's `_pkey` / `_key` protection, for one — keep matching.
 *
 * Ordered longest-first: `_unique_idx` must win over `_idx`.
 */
const PRESERVED_IDENTIFIER_SUFFIXES = [
  '_unique_idx',
  '_pkey',
  '_idx',
  '_key',
] as const;

/**
 * Byte length of `value` when encoded as UTF-8 — what PostgreSQL counts.
 *
 * Hand-rolled rather than `Buffer.byteLength` / `TextEncoder`: this module is
 * re-exported from `schema/utils.ts`, which exists precisely to keep Node-only
 * code out of browser builds, and allocating an encoder per identifier check
 * would be wasteful besides.
 */
export function identifierByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    bytes += codeUnitWidth(value, i);
    if (isSurrogatePair(value, i)) i++;
  }
  return bytes;
}

/**
 * True when `value[index]` is a high surrogate genuinely followed by a low one.
 *
 * The low-surrogate half matters: an unpaired high surrogate is NOT half of a
 * 4-byte code point. Every UTF-8 encoder replaces it with U+FFFD, which is
 * three bytes, so treating "high surrogate, something follows" as a pair
 * *under*-counts a malformed name and can let it past the guard — exactly the
 * silent truncation this module exists to prevent.
 */
function isSurrogatePair(value: string, index: number): boolean {
  const high = value.charCodeAt(index);
  if (high < 0xd800 || high > 0xdbff) return false;
  const low = value.charCodeAt(index + 1);
  return low >= 0xdc00 && low <= 0xdfff;
}

/**
 * UTF-8 byte width of the code point starting at `value[index]`. An unpaired
 * surrogate counts as the three bytes of its U+FFFD replacement.
 */
function codeUnitWidth(value: string, index: number): number {
  const code = value.charCodeAt(index);
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return isSurrogatePair(value, index) ? 4 : 3;
}

/**
 * Longest prefix of `value` that encodes to at most `maxBytes`, never splitting
 * a code point or a surrogate pair.
 */
function truncateToBytes(value: string, maxBytes: number): string {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const width = codeUnitWidth(value, i);
    if (bytes + width > maxBytes) return value.slice(0, i);
    bytes += width;
    if (isSurrogatePair(value, i)) i++;
  }
  return value;
}

/**
 * Deterministic 64-bit FNV-1a digest of `value`, rendered as lowercase hex.
 *
 * Deliberately not `node:crypto`: see {@link identifierByteLength} on why this
 * module must stay free of Node built-ins. FNV-1a is not a cryptographic hash
 * and does not need to be — nothing here is a security boundary; the digest
 * only has to be stable across runtimes, processes and SMRT versions, because
 * a shortened index name that changed between releases would make every
 * deployment drop and recreate the index.
 */
function identifierDigest(value: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  // Hash the UTF-8 bytes, not the UTF-16 code units, so the digest is taken
  // over exactly what PostgreSQL receives — and over exactly what
  // `identifierByteLength` counted. An unpaired surrogate is therefore hashed
  // as its U+FFFD replacement, which is what every real encoder puts on the
  // wire; emitting the surrogate's own three bytes instead would hash bytes the
  // server never sees.
  for (let i = 0; i < value.length; i++) {
    let code = value.codePointAt(i) as number;
    if (code > 0xffff) {
      i++;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }
    const bytes =
      code < 0x80
        ? [code]
        : code < 0x800
          ? [0xc0 | (code >> 6), 0x80 | (code & 0x3f)]
          : code < 0x10000
            ? [
                0xe0 | (code >> 12),
                0x80 | ((code >> 6) & 0x3f),
                0x80 | (code & 0x3f),
              ]
            : [
                0xf0 | (code >> 18),
                0x80 | ((code >> 12) & 0x3f),
                0x80 | ((code >> 6) & 0x3f),
                0x80 | (code & 0x3f),
              ];
    for (const byte of bytes) {
      hash = ((hash ^ BigInt(byte)) * PRIME) & MASK;
    }
  }
  return hash.toString(16).padStart(16, '0').slice(-IDENTIFIER_DIGEST_HEX);
}

/**
 * Shorten a **generated** identifier to fit {@link MAX_IDENTIFIER_BYTES},
 * deterministically and reversibly-by-inspection.
 *
 * A name that already fits is returned unchanged — the overwhelming majority,
 * so existing databases see no churn. An over-long name becomes
 * `<head>_<digest><suffix>`, where `suffix` is the recognisable trailing token
 * (`_idx`, `_unique_idx`, …) when one is present and there is room for it, and
 * `head` is the longest prefix of the remainder that leaves the digest room.
 *
 * The digest is taken over the **full original name**, so two names that share
 * a 63-byte prefix — the case PostgreSQL would collapse into one index — get
 * different digests and stay distinct.
 *
 * Only generator-owned names go through here. A developer's own name
 * (`@smrt({ indexes: [{ name }] })`) is validated with
 * {@link assertIdentifierFits} instead: silently renaming what someone wrote by
 * hand would be worse than refusing it.
 *
 * @param name - The generated identifier
 * @param maxBytes - Override the limit (tests; defaults to the PostgreSQL one)
 * @returns `name` when it fits, otherwise its deterministic short form
 * @throws When `maxBytes` is too small to hold even a digest — the one case
 *   where shortening is genuinely impossible
 * @example
 * // 66 bytes → 63
 * shortenIdentifier('content_contribution_revisions_contribution_id_revision_number_idx')
 */
export function shortenIdentifier(
  name: string,
  maxBytes: number = MAX_IDENTIFIER_BYTES,
): string {
  if (identifierByteLength(name) <= maxBytes) return name;

  const digest = identifierDigest(name);
  // `_` + digest is the irreducible part of the short form.
  const digestCost = 1 + digest.length;
  if (digestCost >= maxBytes) {
    throw new Error(
      `[smrt] Cannot shorten identifier "${name}" to ${maxBytes} bytes: the ` +
        `disambiguating digest alone needs ${digestCost}.`,
    );
  }

  const suffix =
    PRESERVED_IDENTIFIER_SUFFIXES.find(
      (candidate) =>
        name.endsWith(candidate) &&
        // Keep at least one byte of head, or the name becomes just a digest.
        digestCost + candidate.length < maxBytes,
    ) ?? '';

  // The trailing `_` is trimmed because the digest brings its own separator.
  const head = truncateToBytes(
    name.slice(0, name.length - suffix.length),
    maxBytes - digestCost - suffix.length,
  ).replace(/_+$/, '');

  return `${head}_${digest}${suffix}`;
}

/**
 * Reject a **hand-declared** identifier that cannot survive PostgreSQL.
 *
 * Used for names SMRT does not own — a declared index name, a table name
 * derived from a class name, a column name derived from a field name. Each of
 * those is load-bearing somewhere outside schema generation (the runtime reads
 * and writes columns by name; the collection layer resolves tables by name), so
 * quietly rewriting it would break the data path instead of the DDL. Refusing
 * it, with the fix in the message, is the only safe answer.
 *
 * @param name - The identifier to check
 * @param kind - What it is, for the message (`index`, `table`, `column`, …)
 * @param context - Where it came from (`table "x"`, `class Y`), for the message
 * @param maxBytes - Override the limit (tests)
 * @throws When `name` exceeds the limit
 */
export function assertIdentifierFits(
  name: string,
  kind: string,
  context: string,
  maxBytes: number = MAX_IDENTIFIER_BYTES,
): void {
  const bytes = identifierByteLength(name);
  if (bytes <= maxBytes) return;
  throw new Error(
    `[smrt] ${kind} name "${name}" on ${context} is ${bytes} bytes; ` +
      `PostgreSQL truncates identifiers at ${maxBytes} bytes, which silently ` +
      `collapses distinct names into one. Shorten it to ${maxBytes} bytes or fewer.`,
  );
}

/**
 * Apply the identifier guard to one generated schema, in place.
 *
 * Call this as the LAST step of every schema path, after every index pass has
 * run, so it sees the final set. Shortening is safe to do here rather than at
 * each `indexes.push()`: the digest is taken over the full original name, so
 * two entries that were distinct before shortening stay distinct after, and the
 * "does this name already exist" dedupe the passes perform upstream is
 * unaffected.
 *
 * Table and column names are **checked**, not shortened — see
 * {@link assertIdentifierFits}.
 *
 * @param tableName - The table these identifiers belong to
 * @param columns - The generated column map (names are validated)
 * @param indexes - The generated index list (names are shortened in place)
 * @throws When a table or column name exceeds the limit, or when shortening
 *   two index names produces a collision
 */
export function enforceIdentifierLimits(
  tableName: string,
  columns: Record<string, unknown>,
  indexes: Array<{ name: string }>,
): void {
  assertIdentifierFits(
    tableName,
    'Table',
    'the class it is derived from — rename the class',
  );
  for (const column of Object.keys(columns)) {
    assertIdentifierFits(
      column,
      'Column',
      `table "${tableName}" — rename the field`,
    );
  }

  const seen = new Map<string, string>();
  for (const index of indexes) {
    const shortened = shortenIdentifier(index.name);
    const previous = seen.get(shortened);
    if (previous !== undefined && previous !== index.name) {
      throw new Error(
        `[smrt] Index names "${previous}" and "${index.name}" on table ` +
          `"${tableName}" both shorten to "${shortened}". Rename one of them.`,
      );
    }
    seen.set(shortened, index.name);
    index.name = shortened;
  }
}
