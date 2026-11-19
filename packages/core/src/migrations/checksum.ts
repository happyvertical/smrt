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
 * now records {@link computeQuotedTextChecksum}; to compare statements with a
 * checksum read from the tracker, use {@link checksumMatchesRecorded}, which
 * accepts either.
 */
export function computeChecksum(statements: string[]): string {
  const normalized = normalizeSQL(statements);
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * The checksum `MigrationTracker` records: {@link computeChecksum}'s steps,
 * stopping at quotes, so text inside a quoted string or a quoted identifier is
 * data and is hashed as written (see {@link normalizeSQLKeepingQuotedText}).
 * Two statements that differ only inside quotes get different checksums.
 *
 * For a statement whose quoted text holds no comment marker and no whitespace
 * other than single spaces, it equals {@link computeChecksum}.
 */
export function computeQuotedTextChecksum(statements: string[]): string {
  const normalized = normalizeSQLKeepingQuotedText(statements);
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Does `recorded` (a checksum read from the tracker) describe `statements`?
 *
 * True for {@link computeQuotedTextChecksum}, which the tracker records, and
 * for {@link computeChecksum}, which every earlier release recorded, so a
 * database migrated before the tracker kept quoted text never reads as
 * modified. A record written by an earlier release cannot be told from a
 * current record whose quoted text needed no care, so for such a record a
 * later edit that only adds comment markers or extra whitespace inside a
 * quoted string still matches; every other edit, and every edit against a
 * record written from quoted text that did need care, is detected.
 */
export function checksumMatchesRecorded(
  statements: string[],
  recorded: string,
): boolean {
  return (
    recorded === computeQuotedTextChecksum(statements) ||
    recorded === computeChecksum(statements)
  );
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
 * {@link normalizeSQL}'s steps, none of which reaches inside a single-quoted
 * string or a double-quoted identifier: `'a--b'`, `'a  b'` and `'a/*b*\/'`
 * are kept as written, so two statements that differ only there normalize
 * differently. Line endings inside quoted text are folded to `\n`, so a
 * checkout that rewrites them does not read as a modified migration.
 * Dollar-quoted bodies (`$$ ... $$`) are normalized as code, with the quoted
 * text inside them kept.
 *
 * For any statement whose quoted text holds no comment marker and no
 * whitespace other than single spaces, the result is exactly what
 * {@link normalizeSQL} returns.
 */
export function normalizeSQLKeepingQuotedText(statements: string[]): string {
  return statements
    .map((sql) => {
      const { masked, restore } = maskQuotedText(sql);
      return restore(normalizeStatementText(masked));
    })
    .filter((sql) => sql.length > 0)
    .join(';');
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
 * Replace the text between each pair of quotes with a placeholder the
 * normalization steps cannot alter, and return how to put it back.
 *
 * The scan follows SQL's own rules: a quote inside a comment opens nothing, a
 * comment marker inside quotes is text, and a doubled quote (`''`, `""`) is an
 * escaped quote. The quotes themselves stay in place, so text next to a
 * quoted span normalizes exactly as before.
 */
function maskQuotedText(sql: string): {
  masked: string;
  restore: (normalized: string) => string;
} {
  if (!sql.includes("'") && !sql.includes('"')) {
    return { masked: sql, restore: (normalized) => normalized };
  }
  const sentinel = unusedSentinel(sql);
  const contents: string[] = [];
  let masked = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? sql.length : end;
      masked += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      masked += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] !== char) {
          end += 1;
        } else if (sql[end + 1] === char) {
          end += 2;
        } else {
          break;
        }
      }
      // An unterminated quote runs to the end of the statement.
      const closed = end < sql.length;
      const content = sql.slice(index + 1, closed ? end : sql.length);
      masked += `${char}${sentinel}${contents.length}${sentinel}${closed ? char : ''}`;
      contents.push(content.replace(/\r\n?/g, '\n'));
      index = closed ? end + 1 : sql.length;
      continue;
    }
    masked += char;
    index += 1;
  }
  const placeholder = new RegExp(`${sentinel}(\\d+)${sentinel}`, 'g');
  return {
    masked,
    restore: (normalized) =>
      normalized.replace(
        placeholder,
        (_match, position: string) => contents[Number(position)] ?? '',
      ),
  };
}

/** A private-use character that does not occur in `sql`. */
function unusedSentinel(sql: string): string {
  for (let code = 0xe000; code <= 0xf8ff; code++) {
    const candidate = String.fromCharCode(code);
    if (!sql.includes(candidate)) return candidate;
  }
  throw new Error(
    'Cannot normalize SQL that uses every private-use character.',
  );
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
 * Generate a short checksum for display (first 8 characters)
 */
export function shortChecksum(checksum: string): string {
  return checksum.substring(0, 8);
}
