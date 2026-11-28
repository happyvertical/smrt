/**
 * Migration Checksum Utilities
 *
 * Provides SHA-256 checksum computation for migration idempotency
 * and drift detection.
 */

import { createHash } from 'node:crypto';

/**
 * Compute SHA-256 checksum of migration SQL statements
 *
 * Normalizes SQL before hashing to ensure consistent checksums:
 * - Removes single-line and multi-line comments
 * - Collapses whitespace
 * - Trims each statement
 *
 * These steps run over the whole statement, quoted text included, exactly as
 * they always have: the value is stable across releases and matches every
 * record written before {@link computeQuotedTextChecksum}. `MigrationTracker`
 * now records {@link computeQuotedTextChecksum} (a `v2:`-prefixed value) for
 * new migrations; to compare statements with a checksum read from the
 * tracker, use {@link checksumMatchesRecorded}, which reads either form.
 */
export function computeChecksum(statements: string[]): string {
  const normalized = normalizeSQL(statements);
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Prefix of the checksum form `MigrationTracker` writes for a new record.
 * A record without it was written by an earlier release, from
 * {@link computeChecksum}; the prefix is what tells the two apart, so the
 * earlier form's normalization (which reaches into quoted text) applies only
 * to records that were written with it.
 */
const QUOTED_TEXT_CHECKSUM_PREFIX = 'v2:';

/**
 * The checksum `MigrationTracker` records for a new migration: a `v2:` prefix
 * and the SHA-256 of the earlier form's digest ({@link computeChecksum}, always
 * 64 hex characters) followed directly by
 * {@link normalizeSQLKeepingQuotedText}. The fixed width makes the input
 * unambiguous with no separator, whatever characters the SQL holds. Quoted
 * text (a string, a quoted identifier, a dollar-quoted body) is data and is
 * hashed as written, so two statements that differ only inside quotes get
 * different checksums. Because the earlier digest is part of the input, an
 * edit the earlier form detects is always detected here too: this form never
 * detects less than {@link computeChecksum}. The prefix keeps it distinct from
 * that form.
 */
export function computeQuotedTextChecksum(statements: string[]): string {
  const combined = `${computeChecksum(statements)}${normalizeSQLKeepingQuotedText(statements)}`;
  return (
    QUOTED_TEXT_CHECKSUM_PREFIX +
    createHash('sha256').update(combined).digest('hex')
  );
}

/**
 * Does `recorded` (a checksum read from the tracker) describe `statements`?
 *
 * A record with the `v2:` prefix is compared with
 * {@link computeQuotedTextChecksum}, and only with it. A record without the
 * prefix was written by an earlier release and is compared with
 * {@link computeChecksum}, so a database migrated before the tracker kept
 * quoted text never reads as modified. The cost sits with those records
 * alone: an edit inside quoted text that the earlier normalization hides (a
 * comment marker, repeated whitespace, a line ending) still matches them.
 */
export function checksumMatchesRecorded(
  statements: string[],
  recorded: string,
): boolean {
  return recorded.startsWith(QUOTED_TEXT_CHECKSUM_PREFIX)
    ? recorded === computeQuotedTextChecksum(statements)
    : recorded === computeChecksum(statements);
}

/**
 * Verify `statements` against a record read from the tracker: the replacement
 * for `verifyChecksum(computeChecksum(up), recorded, applied)`. Like
 * {@link verifyChecksum} it reports `file_modified` when the statements no
 * longer match `recordChecksum` (read in whichever form the record has, see
 * {@link checksumMatchesRecorded}) and `db_modified` when the record matches but
 * `appliedChecksum`, what was actually applied, differs from it.
 */
export function verifyRecordedChecksum(
  statements: string[],
  recordChecksum: string,
  appliedChecksum?: string | null,
): { valid: boolean; drift?: 'file_modified' | 'db_modified' } {
  return verifyChecksum(
    checksumMatchesRecorded(statements, recordChecksum)
      ? recordChecksum
      : computeQuotedTextChecksum(statements),
    recordChecksum,
    appliedChecksum,
  );
}

/**
 * The checksum to write when the tracker records `statements`. A new record
 * gets {@link computeQuotedTextChecksum}. A record an earlier release wrote
 * (no `v2:` prefix) stays in its own form whenever it is written again: the
 * same value when the statements still match it, and
 * {@link computeChecksum} of the new statements when they do not (a forced
 * edit). Rewriting it as `v2:` would make a build that predates the prefix
 * read the migration as modified (a rolling deploy, a rollback). A `v2:`
 * record stays `v2:`.
 */
export function checksumToRecord(
  statements: string[],
  existingRecorded: string | null | undefined,
): string {
  return existingRecorded != null &&
    !existingRecorded.startsWith(QUOTED_TEXT_CHECKSUM_PREFIX)
    ? computeChecksum(statements)
    : computeQuotedTextChecksum(statements);
}

/**
 * Normalize SQL statements for consistent checksums
 *
 * Steps:
 * 1. Remove single-line comments (-- ...)
 * 2. Remove multi-line comments (/* ... *\/)
 * 3. Collapse multiple whitespace to single space
 * 4. Trim each statement
 * 5. Filter empty statements
 * 6. Join with semicolons
 *
 * The steps run over quoted text too; {@link normalizeSQLKeepingQuotedText}
 * is the form that stops at quotes. Unchanged, for {@link computeChecksum}.
 */
export function normalizeSQL(statements: string[]): string {
  return statements
    .map(normalizeStatementText)
    .filter((sql) => sql.length > 0)
    .join(';');
}

/**
 * Normalize each statement in one scan that reads comments and quoted text
 * together, so neither can hide the other: comments are dropped, whitespace
 * outside quotes collapses to one space, and quoted text is kept exactly as
 * written, line endings included. Quoted text is:
 *
 * - `'...'` with `''` as an escaped quote, and `E'...'` where a backslash
 *   escapes the next character (so `\'` does not close it);
 * - `"..."` and `` `...` `` with a doubled delimiter as an escape, and
 *   `[...]` (a SQLite identifier) up to the first `]`, only where it cannot be
 *   array syntax (see {@link bracketIdentifierEnd});
 * - a PostgreSQL dollar-quoted body, `$$...$$` or `$tag$...$tag$`, up to the
 *   same tag, whatever the tag's length.
 *
 * Comments are `-- ...` to the end of the line and `/* ... *\/`. A block
 * comment ends at its first `*\/` and does not nest, on every engine, so a
 * `/*` inside one is text. On PostgreSQL, which nests, the tail of a nested
 * comment is therefore hashed as code and an edit there reads as modified. A
 * quote or a comment marker inside a comment, and a comment marker inside
 * quoted text, is text. An unterminated quote runs to the end of the
 * statement.
 */
export function normalizeSQLKeepingQuotedText(statements: string[]): string {
  return statements
    .map(scanStatement)
    .filter((sql) => sql.length > 0)
    .join(';');
}

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$\u0080-￿]/.test(char);
}

/** The end (exclusive) of the quoted span that opens at `start`. */
function quotedSpanEnd(
  sql: string,
  start: number,
  quote: string,
  backslashEscapes: boolean,
): number {
  let index = start + 1;
  while (index < sql.length) {
    if (backslashEscapes && sql[index] === '\\') {
      index += 2;
    } else if (sql[index] !== quote) {
      index += 1;
    } else if (sql[index + 1] === quote) {
      index += 2;
    } else {
      return index + 1;
    }
  }
  return sql.length;
}

/**
 * The end (exclusive) of the block comment that opens at `start`. A block
 * comment ends at its first `*\/`, on every engine, and does not nest: a `/*`
 * inside it is text. SQLite and DuckDB read comments this way, and the earlier
 * digest form did too, so the code after the first `*\/` is always hashed as
 * code. PostgreSQL nests, so there the tail of a nested comment is hashed as
 * code and an edit in it reads as modified.
 */
function blockCommentEnd(sql: string, start: number): number {
  const close = sql.indexOf('*/', start + 2);
  return close === -1 ? sql.length : close + 2;
}

/**
 * Does the `[` at `start` open a bracket identifier (SQLite), and where does
 * it end (exclusive)? On PostgreSQL and DuckDB `[` is array syntax, so it is an
 * identifier only when nothing suggests an array: it does not follow an
 * identifier character, `]` or `)` directly (`ARRAY[`, `col[1]`, `int[]`), and
 * the text up to the first `]` holds no quote, `$`, comment marker or line
 * break. Anything else is scanned as code, so a `]` inside a string never
 * ends a span.
 */
function bracketIdentifierEnd(sql: string, start: number): number | null {
  const before = sql[start - 1];
  if (isIdentifierChar(before) || before === ']' || before === ')') return null;
  const close = sql.indexOf(']', start + 1);
  if (close === -1) return null;
  const inside = sql.slice(start + 1, close);
  return /['"`$\r\n]|--|\/\*/.test(inside) ? null : close + 1;
}

// Sticky: the whole opening tag is matched at the offset, however long.
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;

function scanStatement(sql: string): string {
  let out = '';
  let pendingSpace = false;
  let index = 0;
  const emit = (text: string) => {
    if (pendingSpace && out.length > 0) out += ' ';
    pendingSpace = false;
    out += text;
  };
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (/\s/.test(char)) {
      pendingSpace = true;
      index += 1;
    } else if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r')
        index += 1;
      pendingSpace = true;
    } else if (char === '/' && next === '*') {
      index = blockCommentEnd(sql, index);
      pendingSpace = true;
    } else if (char === "'" || char === '"' || char === '`') {
      const escapeString =
        char === "'" &&
        (sql[index - 1] === 'E' || sql[index - 1] === 'e') &&
        !isIdentifierChar(sql[index - 2]);
      const end = quotedSpanEnd(sql, index, char, escapeString);
      emit(sql.slice(index, end));
      index = end;
    } else if (char === '[' && bracketIdentifierEnd(sql, index) !== null) {
      const end = bracketIdentifierEnd(sql, index) as number;
      emit(sql.slice(index, end));
      index = end;
    } else if (char === '$' && !isIdentifierChar(sql[index - 1])) {
      DOLLAR_TAG.lastIndex = index;
      const tag = DOLLAR_TAG.exec(sql);
      if (tag) {
        const close = sql.indexOf(tag[0], index + tag[0].length);
        const end = close === -1 ? sql.length : close + tag[0].length;
        emit(sql.slice(index, end));
        index = end;
      } else {
        emit(char);
        index += 1;
      }
    } else {
      emit(char);
      index += 1;
    }
  }
  return out;
}

function normalizeStatementText(sql: string): string {
  // Remove single-line comments
  let normalized = sql.replace(/--.*$/gm, '');
  // Remove multi-line comments
  normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, '');
  // Collapse whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}

/**
 * Verify that a migration file hasn't been modified since application
 *
 * @param definitionChecksum - Checksum from current migration definition
 * @param recordChecksum - Checksum stored when migration was applied
 * @param appliedChecksum - Checksum of what was actually applied (for drift)
 */
export function verifyChecksum(
  definitionChecksum: string,
  recordChecksum: string,
  appliedChecksum?: string | null,
): { valid: boolean; drift?: 'file_modified' | 'db_modified' } {
  // Check if definition file was modified after application
  if (definitionChecksum !== recordChecksum) {
    return { valid: false, drift: 'file_modified' };
  }

  // Check if what was applied differs from what we expected
  if (appliedChecksum && appliedChecksum !== recordChecksum) {
    return { valid: false, drift: 'db_modified' };
  }

  return { valid: true };
}

/**
 * Generate a short checksum for display (first 8 characters by default,
 * without the `v2:` prefix of a record written by this release)
 */
export function shortChecksum(checksum: string, length = 8): string {
  return checksum.replace(/^v\d+:/, '').substring(0, length);
}
