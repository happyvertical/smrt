/**
 * Checksum Module Tests
 *
 * Tests for SHA-256 checksum computation and SQL normalization.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDDLStrategy } from '../../schema/ddl/index.js';
import type { SchemaDefinition } from '../../schema/types.js';
import {
  checksumMatchesRecorded,
  checksumToRecord,
  computeChecksum,
  computeQuotedTextChecksum,
  normalizeSQL,
  normalizeSQLKeepingQuotedText,
  shortChecksum,
  verifyChecksum,
  verifyRecordedChecksum,
} from '../checksum.js';

const CORE_ROOT = join(import.meta.dirname, '../../..');

describe('checksum', () => {
  describe('normalizeSQL', () => {
    it('should remove SQL comments', () => {
      const sql = [
        '-- This is a comment',
        'CREATE TABLE users (id TEXT PRIMARY KEY);',
        '-- Another comment',
      ];

      const normalized = normalizeSQL(sql);

      expect(normalized).not.toContain('comment');
      expect(normalized).toContain('CREATE TABLE users');
    });

    it('should remove multi-line comments', () => {
      const sql = [
        `/* This is
           a multi-line
           comment */
        CREATE TABLE users (id TEXT);`,
      ];

      const normalized = normalizeSQL(sql);

      expect(normalized).not.toContain('multi-line');
      expect(normalized).toContain('CREATE TABLE users');
    });

    it('should collapse whitespace', () => {
      const sql = [
        `CREATE   TABLE    users (
          id     TEXT   PRIMARY   KEY
        );`,
      ];

      const normalized = normalizeSQL(sql);

      // Should not have multiple consecutive spaces
      expect(normalized).not.toMatch(/\s{2,}/);
    });

    it('should trim leading and trailing whitespace', () => {
      const sql = ['   CREATE TABLE users (id TEXT);   '];

      const normalized = normalizeSQL(sql);

      expect(normalized).toBe('CREATE TABLE users (id TEXT);');
    });

    it('should handle empty input', () => {
      expect(normalizeSQL([])).toBe('');
      expect(normalizeSQL(['   '])).toBe('');
    });

    it('should join multiple statements with semicolons', () => {
      const sql = [
        'CREATE TABLE users (id TEXT)',
        'CREATE TABLE posts (id TEXT)',
      ];
      const normalized = normalizeSQL(sql);
      expect(normalized).toBe(
        'CREATE TABLE users (id TEXT);CREATE TABLE posts (id TEXT)',
      );
    });
  });

  describe('computeChecksum', () => {
    it('should return consistent checksum for same SQL', () => {
      const sql = ['CREATE TABLE users (id TEXT PRIMARY KEY);'];

      const checksum1 = computeChecksum(sql);
      const checksum2 = computeChecksum(sql);

      expect(checksum1).toBe(checksum2);
    });

    it('should return same checksum for equivalent SQL with different formatting', () => {
      // Test that consecutive whitespace is collapsed
      const sql1 = ['CREATE TABLE users (id TEXT);'];
      const sql2 = ['CREATE   TABLE    users    (id    TEXT);'];

      // After normalization (whitespace collapse), these should be equivalent
      expect(computeChecksum(sql1)).toBe(computeChecksum(sql2));

      // Also verify the normalized forms are equal
      expect(normalizeSQL(sql1)).toBe(normalizeSQL(sql2));
    });

    it('should return same checksum for SQL with different comments', () => {
      const sql1 = ['-- Comment 1\nCREATE TABLE users (id TEXT);'];
      const sql2 = ['-- Comment 2\nCREATE TABLE users (id TEXT);'];

      expect(computeChecksum(sql1)).toBe(computeChecksum(sql2));
    });

    it('should return different checksums for different SQL', () => {
      const sql1 = ['CREATE TABLE users (id TEXT);'];
      const sql2 = ['CREATE TABLE profiles (id TEXT);'];

      expect(computeChecksum(sql1)).not.toBe(computeChecksum(sql2));
    });

    it('should return 64-character hex string (SHA-256)', () => {
      const sql = ['CREATE TABLE users (id TEXT);'];
      const checksum = computeChecksum(sql);

      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should handle array of SQL statements', () => {
      const statements = [
        'CREATE TABLE users (id TEXT);',
        'CREATE INDEX idx_users ON users(id);',
      ];

      const checksum = computeChecksum(statements);

      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should return consistent checksum for array of statements', () => {
      const statements = [
        'CREATE TABLE users (id TEXT);',
        'CREATE INDEX idx_users ON users(id);',
      ];

      expect(computeChecksum(statements)).toBe(computeChecksum(statements));
    });
  });

  describe('shortChecksum', () => {
    it('should return first 8 characters by default', () => {
      const sql = ['CREATE TABLE users (id TEXT);'];
      const full = computeChecksum(sql);
      const short = shortChecksum(full);

      expect(short).toBe(full.substring(0, 8));
      expect(short).toHaveLength(8);
    });

    it('should handle checksum shorter than requested length', () => {
      const short = shortChecksum('abc');

      expect(short).toBe('abc');
    });

    it('drops the record-format prefix and takes the requested length', () => {
      const recorded = computeQuotedTextChecksum(['SELECT 1']);
      expect(shortChecksum(recorded)).toBe(recorded.slice(3, 11));
      expect(shortChecksum(recorded, 16)).toBe(recorded.slice(3, 19));
    });
  });

  describe('verifyChecksum', () => {
    it('should return valid when checksums match', () => {
      const result = verifyChecksum('abc123', 'abc123');
      expect(result.valid).toBe(true);
      expect(result.drift).toBeUndefined();
    });

    it('should detect file_modified drift', () => {
      const result = verifyChecksum('abc123', 'def456');
      expect(result.valid).toBe(false);
      expect(result.drift).toBe('file_modified');
    });

    it('should detect db_modified drift', () => {
      const result = verifyChecksum('abc123', 'abc123', 'xyz789');
      expect(result.valid).toBe(false);
      expect(result.drift).toBe('db_modified');
    });

    it('should return valid when applied checksum matches', () => {
      const result = verifyChecksum('abc123', 'abc123', 'abc123');
      expect(result.valid).toBe(true);
    });
  });

  describe('the public verification path', () => {
    const statements = [
      "UPDATE notes SET label = 'two  spaces' WHERE label IS NULL",
    ];

    it('keeps computeChecksum as every earlier release computed it', () => {
      expect(normalizeSQL(statements)).toBe(
        "UPDATE notes SET label = 'two spaces' WHERE label IS NULL",
      );
      expect(computeChecksum(statements)).toMatch(/^[a-f0-9]{64}$/);
      expect(computeChecksum(statements)).not.toBe(
        computeQuotedTextChecksum(statements),
      );
    });

    it('verifies unchanged SQL with a literal against a record an earlier release wrote', () => {
      const recorded = computeChecksum(statements);
      expect(
        verifyChecksum(computeChecksum(statements), recorded, recorded),
      ).toEqual({ valid: true });
      expect(checksumMatchesRecorded(statements, recorded)).toBe(true);
    });

    it('records new migrations in a form of their own, read through checksumMatchesRecorded', () => {
      const recorded = computeQuotedTextChecksum(statements);
      expect(recorded).toMatch(/^v2:[a-f0-9]{64}$/);
      expect(checksumMatchesRecorded(statements, recorded)).toBe(true);
      // The documented break: the earlier public call no longer matches a
      // record this release writes.
      expect(
        verifyChecksum(computeChecksum(statements), recorded, recorded),
      ).toEqual({ valid: false, drift: 'file_modified' });
      expect(shortChecksum(recorded)).toBe(recorded.slice(3, 11));
    });

    it('applies the earlier normalization to earlier records only', () => {
      const original = ["UPDATE notes SET label = 'two spaces'"];
      const edited = ["UPDATE notes SET label = 'two  spaces'"];
      // An earlier record cannot see the edit (the cost of that form) ...
      expect(checksumMatchesRecorded(edited, computeChecksum(original))).toBe(
        true,
      );
      // ... a record this release wrote sees it, in both directions.
      expect(
        checksumMatchesRecorded(edited, computeQuotedTextChecksum(original)),
      ).toBe(false);
      expect(
        checksumMatchesRecorded(original, computeQuotedTextChecksum(edited)),
      ).toBe(false);
    });

    it('keeps an earlier record as it is when it is written again, and writes the new form for a new record', () => {
      const earlier = computeChecksum(statements);
      expect(checksumToRecord(statements, earlier)).toBe(earlier);
      expect(checksumToRecord(statements, null)).toBe(
        computeQuotedTextChecksum(statements),
      );
      // A record that no longer describes the statements (a forced change)
      // is updated in its own form: an earlier record stays an earlier-form
      // digest, so a build that predates the prefix still reads it.
      const edited = ["UPDATE notes SET label = 'other  text'"];
      expect(checksumToRecord(edited, earlier)).toBe(computeChecksum(edited));
      expect(checksumToRecord(edited, earlier)).not.toMatch(/^v2:/);
      const current = computeQuotedTextChecksum(statements);
      expect(checksumToRecord(statements, current)).toBe(current);
      expect(checksumToRecord(edited, current)).toBe(
        computeQuotedTextChecksum(edited),
      );
    });

    it('verifies statements against both stored values, for each record format', () => {
      for (const recorded of [
        computeChecksum(statements),
        computeQuotedTextChecksum(statements),
      ]) {
        expect(verifyRecordedChecksum(statements, recorded, recorded)).toEqual({
          valid: true,
        });
        expect(verifyRecordedChecksum(statements, recorded)).toEqual({
          valid: true,
        });
        expect(verifyRecordedChecksum(statements, recorded, null)).toEqual({
          valid: true,
        });
        // The file matches the record, what was applied differs.
        expect(
          verifyRecordedChecksum(statements, recorded, 'a'.repeat(64)),
        ).toEqual({ valid: false, drift: 'db_modified' });
        // The statements changed after the record was written.
        expect(
          verifyRecordedChecksum(['SELECT 1'], recorded, recorded),
        ).toEqual({ valid: false, drift: 'file_modified' });
      }
    });
  });

  describe('the tracker compares recorded checksums through checksumMatchesRecorded', () => {
    // A tripwire, not proof: it catches the common ways of reading a record
    // directly. The behaviour tests in tracker.test.ts (apply, the batch
    // pre-check, drift, the concurrent-index retry) are what hold the rule.
    const source = readFileSync(
      join(CORE_ROOT, 'src/migrations/tracker.ts'),
      'utf8',
    );

    it('has no direct comparison of checksum values and no unguarded verifyChecksum on a record', () => {
      expect(source).not.toMatch(/\bchecksum\s*[!=]==?/i);
      expect(source).not.toMatch(/[!=]==?\s*[\w.]*checksum\b/i);
      expect(source).not.toMatch(/computeChecksum\(/);
      // A record is verified in one place, with the statements and both
      // stored values.
      expect(source).not.toMatch(/\bverifyChecksum\(/);
      expect(source.match(/verifyRecordedChecksum\(/g) ?? []).toHaveLength(1);
      expect(source).toMatch(
        /verifyRecordedChecksum\(\s*definition\.up,\s*record\.checksum,\s*record\.applied_checksum/,
      );
    });
  });

  describe('quoted text', () => {
    // Each pair differs only inside text the database stores as written.
    it.each([
      ['a comment marker', "'n/a--legacy'", "'n/a--v2'"],
      ['a block comment marker', "'a/*x*/b'", "'a/*y*/b'"],
      ['a run of spaces', "'x  y'", "'x y'"],
      ['a tab', "'x\ty'", "'x y'"],
      ['a line break', "'x\ny'", "'x y'"],
      ['a carriage return', "'x\r\ny'", "'x\ny'"],
      ['an escaped quote before a marker', "'it''s --a'", "'it''s --b'"],
      [
        'a backslash-escaped quote in an E string',
        "E'it\\'s --old'",
        "E'it\\'s --new'",
      ],
      ['a lower-case e string', "e'it\\'s --old'", "e'it\\'s --new'"],
      ['an anonymous dollar body', '$$a--old$$', '$$a--new$$'],
      ['a named dollar body', '$fn$a--old$fn$', '$fn$a--new$fn$'],
      [
        'a dollar body holding another tag',
        '$a$ $b$ x $b$ --1 $a$',
        '$a$ $b$ x $b$ --2 $a$',
      ],
      ['spacing in a dollar body', '$$a  b$$', '$$a b$$'],
      ['spacing in a backtick identifier', '`a  b`', '`a b`'],
      ['spacing in a bracket identifier', '[a  b]', '[a b]'],
      ['spacing in a double-quoted identifier', '"a  b"', '"a b"'],
    ])('hashes two statements that differ only by %s differently', (_name, left, right) => {
      const one = [`UPDATE notes SET label = ${left} WHERE label IS NULL`];
      const other = [`UPDATE notes SET label = ${right} WHERE label IS NULL`];
      expect(normalizeSQLKeepingQuotedText(one)).toContain(left);
      expect(normalizeSQLKeepingQuotedText(other)).toContain(right);
      expect(computeQuotedTextChecksum(one)).not.toBe(
        computeQuotedTextChecksum(other),
      );
      // Both directions through the check that guards a recorded migration.
      expect(
        checksumMatchesRecorded(other, computeQuotedTextChecksum(one)),
      ).toBe(false);
      expect(
        checksumMatchesRecorded(one, computeQuotedTextChecksum(other)),
      ).toBe(false);
    });

    it.each([
      [
        'a line comment holding a block comment marker',
        "UPDATE notes /* -- rationale */ SET label = 'old'",
        "UPDATE notes /* -- rationale */ SET label = 'new'",
      ],
      [
        'a nested block comment',
        "UPDATE notes /* a /* b */ c */ SET label = 'old'",
        "UPDATE notes /* a /* b */ c */ SET label = 'new'",
      ],
      [
        'a block comment before a literal on the same line',
        "SELECT 1 /* a -- b */, 'x  y'",
        "SELECT 1 /* a -- b */, 'x y'",
      ],
    ])('does not let a comment hide the code after it: %s', (_name, one, other) => {
      expect(computeQuotedTextChecksum([one])).not.toBe(
        computeQuotedTextChecksum([other]),
      );
    });

    it('hashes the tail of a nested block comment as code, so an edit there reads as modified', () => {
      // PostgreSQL nests; the scan does not, on any engine. The comment ends at
      // its first close marker and the rest is code.
      expect(
        normalizeSQLKeepingQuotedText([
          'SELECT /* outer /* inner */ still outer */ 1',
        ]),
      ).toBe('SELECT still outer */ 1');
      expect(
        computeQuotedTextChecksum(['SELECT /* a /* b */ c */ 1']),
      ).not.toBe(computeQuotedTextChecksum(['SELECT /* x /* y */ z */ 1']));
      // An edit in the head of the comment is still not a change.
      expect(computeQuotedTextChecksum(['SELECT /* a /* b */ c */ 1'])).toBe(
        computeQuotedTextChecksum(['SELECT /* x /* b */ c */ 1']),
      );
    });

    it('keeps a quoted identifier as written', () => {
      const one = ['ALTER TABLE notes RENAME COLUMN "old  name" TO fresh'];
      const other = ['ALTER TABLE notes RENAME COLUMN "old name" TO fresh'];
      expect(computeQuotedTextChecksum(one)).not.toBe(
        computeQuotedTextChecksum(other),
      );
    });

    it('still ignores comments and layout outside quoted text', () => {
      const compact = ["UPDATE notes SET label = 'a--b' WHERE id = 'x  y'"];
      const spread = [
        `-- why this runs
         UPDATE   notes /* the table */
            SET label = 'a--b' -- don't touch 'a--b'
          WHERE id = 'x  y'  `,
      ];
      expect(normalizeSQLKeepingQuotedText(spread)).toBe(
        normalizeSQLKeepingQuotedText(compact),
      );
      // The digest also hashes the earlier form's text, which reads a comment
      // marker inside a string as a comment, so digest equality is asserted
      // where both forms agree: no comment marker inside a string.
      const plainCompact = ["UPDATE notes SET label = 'ab' WHERE id = 'x  y'"];
      const plainSpread = [
        `-- why this runs
         UPDATE   notes /* the table */
            SET label = 'ab' -- keep it
          WHERE id = 'x  y'  `,
      ];
      expect(computeQuotedTextChecksum(plainSpread)).toBe(
        computeQuotedTextChecksum(plainCompact),
      );
    });

    it('does not open a string at a quote inside a comment', () => {
      const withApostrophe = [
        "-- the owner's note\nSELECT   1 /* isn't data */   + 2",
      ];
      expect(normalizeSQLKeepingQuotedText(withApostrophe)).toBe(
        'SELECT 1 + 2',
      );
    });

    it('ends a line comment at a carriage return as well as a line feed', () => {
      expect(normalizeSQLKeepingQuotedText(['SELECT 1 -- note\rFROM t'])).toBe(
        'SELECT 1 FROM t',
      );
    });

    it('does not read a dollar sign inside an identifier or a parameter as a quote', () => {
      expect(
        normalizeSQLKeepingQuotedText(['SELECT a$b$  c, $1,   $2 FROM t']),
      ).toBe('SELECT a$b$ c, $1, $2 FROM t');
    });

    it('keeps an unterminated quote, bracket, dollar body or comment to the end of the statement', () => {
      expect(normalizeSQLKeepingQuotedText(["SELECT 'open  text"])).toBe(
        "SELECT 'open  text",
      );
      // An unclosed bracket is not an identifier: it is scanned as code.
      expect(normalizeSQLKeepingQuotedText(['SELECT [open  id'])).toBe(
        'SELECT [open id',
      );
      expect(normalizeSQLKeepingQuotedText(['DO $$ open  body'])).toBe(
        'DO $$ open  body',
      );
      expect(normalizeSQLKeepingQuotedText(['SELECT 1 /* open'])).toBe(
        'SELECT 1',
      );
    });

    // Every pair that an earlier review round showed the quote-aware scan
    // alone could not tell apart, though the earlier digest could.
    const REGRESSION_PAIRS: [string, string, string][] = [
      [
        'a stray open marker closed by a marker in a later literal',
        "/* strip /* markers */ UPDATE notes SET kind = 'old', body = replace(body, '*/', '')",
        "/* strip /* markers */ UPDATE notes SET kind = 'new', body = replace(body, '*/', '')",
      ],
      [
        'a comment ending in a glob before a literal holding a close marker',
        "UPDATE routes /* old glob: /img/* */ SET pattern = 'old*/logo.svg'",
        "UPDATE routes /* old glob: /img/* */ SET pattern = 'new*/logo.svg'",
      ],
      [
        'a nested comment tail holding an apostrophe, before a literal holding an open marker',
        "UPDATE notes /* outer /* inner */ owner's note */ SET label = '/*old'",
        "UPDATE notes /* outer /* inner */ owner's note */ SET label = '/*new'",
      ],
      [
        'a bracket identifier holding an open marker',
        'ALTER TABLE t RENAME COLUMN [a/*b] TO c',
        'ALTER TABLE t RENAME COLUMN [a/*b] TO d',
      ],
      [
        'statements holding a NUL character',
        'SELECT 1 /* -- */ + 2\u0000SELECT 1',
        'SELECT 1 /*\u0000SELECT 1 + 2',
      ],
      [
        'a nested comment tail with an odd quote, before a literal holding an open marker',
        "/* a /* b */ it's */ UPDATE n SET k = 'x', m = '/*', body = 'old'",
        "/* a /* b */ it's */ UPDATE n SET k = 'x', m = '/*', body = 'new'",
      ],
    ];

    it.each(
      REGRESSION_PAIRS,
    )('tells apart, in both directions, what the earlier digest told apart: %s', (_name, one, other) => {
      expect(computeChecksum([one])).not.toBe(computeChecksum([other]));
      expect(computeQuotedTextChecksum([one])).not.toBe(
        computeQuotedTextChecksum([other]),
      );
      expect(computeQuotedTextChecksum([other])).not.toBe(
        computeQuotedTextChecksum([one]),
      );
    });

    it('never detects less than the earlier digest over a corpus of statements', () => {
      const corpus = [
        ...REGRESSION_PAIRS.flatMap(([, one, other]) => [one, other]),
        "SELECT 'a  b'",
        "SELECT 'a b'",
        'SELECT 1 /* a /* b',
        'SELECT 1 /* a /* b */ c */',
        "SELECT 'it''s' -- note",
        "SELECT E'it\\'s' /* x */",
        'SELECT [a b] FROM t',
        'SELECT $$ a /* b $$',
        'SELECT $t$ a -- b $t$',
        'SELECT (ARRAY[1,2])[1]',
        "/* a /* b */ -- c */ UPDATE n SET k = 'old'",
        "/* a /* b */ -- c */ UPDATE n SET k = 'new'",
        'ALTER TABLE t RENAME COLUMN [a/*b] TO e',
        '',
      ];
      let compared = 0;
      for (const left of corpus) {
        for (const right of corpus) {
          if (computeChecksum([left]) !== computeChecksum([right])) {
            compared += 1;
            expect(
              computeQuotedTextChecksum([left]),
              `${left} | ${right}`,
            ).not.toBe(computeQuotedTextChecksum([right]));
          }
        }
      }
      expect(compared).toBeGreaterThan(0);
    });

    it('ends every block comment at its first close marker', () => {
      const one = ["UPDATE notes /* example /* marker */ SET label = 'old'"];
      const other = ["UPDATE notes /* example /* marker */ SET label = 'new'"];
      expect(normalizeSQLKeepingQuotedText(one)).toBe(
        "UPDATE notes SET label = 'old'",
      );
      expect(computeQuotedTextChecksum(one)).not.toBe(
        computeQuotedTextChecksum(other),
      );
      // A comment that opens and never closes at all runs to the end.
      expect(normalizeSQLKeepingQuotedText(['SELECT 1 /* a /* b'])).toBe(
        'SELECT 1',
      );
    });

    it.each([
      [
        'a comment holding a stray open marker, closed by a marker in a later literal',
        "/* strip /* markers */ UPDATE notes SET kind = 'old', body = replace(body, '*/', '')",
        "/* strip /* markers */ UPDATE notes SET kind = 'new', body = replace(body, '*/', '')",
      ],
      [
        'a comment ending in a glob, with a later literal holding a close marker',
        "UPDATE routes /* old glob: /img/* */ SET pattern = 'old*/logo.svg'",
        "UPDATE routes /* old glob: /img/* */ SET pattern = 'new*/logo.svg'",
      ],
    ])('does not let a stray open marker hide the literal after the first close marker: %s', (_name, one, other) => {
      expect(computeQuotedTextChecksum([one])).not.toBe(
        computeQuotedTextChecksum([other]),
      );
      expect(computeQuotedTextChecksum([other])).not.toBe(
        computeQuotedTextChecksum([one]),
      );
      expect(normalizeSQLKeepingQuotedText([one])).toContain("'old");
    });

    it.each([
      [
        'a string with a bracket in an array',
        "UPDATE notes SET label = (ARRAY[']', 'a  b'])[2]",
        "UPDATE notes SET label = (ARRAY[']', 'a b'])[2]",
      ],
      [
        'a comment marker after a bracketed string',
        "UPDATE notes SET label = (ARRAY['[draft]', 'n/a--old'])[2]",
        "UPDATE notes SET label = (ARRAY['[draft]', 'n/a--new'])[2]",
      ],
      [
        'a subscript',
        "UPDATE notes SET label = tags[1] || 'a  b'",
        "UPDATE notes SET label = tags[1] || 'a b'",
      ],
    ])('does not read an array bracket as an identifier: %s', (_name, one, other) => {
      expect(computeQuotedTextChecksum([one])).not.toBe(
        computeQuotedTextChecksum([other]),
      );
    });

    it('keeps a reformatted multi-line array matching', () => {
      // Layout (line breaks, indentation, comments) changes nothing; it was
      // read verbatim while the whole array counted as a bracket identifier.
      const compact = ["SELECT ARRAY[ 1, 2, 3 ]::int[], 'a  b'"];
      const spread = [
        `SELECT ARRAY[
           1,
           2, -- the middle one
           3
         ]::int[],   'a  b'`,
      ];
      expect(computeQuotedTextChecksum(spread)).toBe(
        computeQuotedTextChecksum(compact),
      );
    });

    it('still reads a bracket identifier on its own', () => {
      expect(
        normalizeSQLKeepingQuotedText(['SELECT t.[a  b], [c  d] FROM t']),
      ).toBe('SELECT t.[a  b], [c  d] FROM t');
    });

    it('matches a dollar tag of any length', () => {
      for (const length of [1, 63, 256, 257, 300, 1000]) {
        const tag = `t${'x'.repeat(length - 1)}`;
        const one = [`UPDATE notes SET label = $${tag}$a  b$${tag}$`];
        const other = [`UPDATE notes SET label = $${tag}$a b$${tag}$`];
        expect(normalizeSQLKeepingQuotedText(one)).toBe(one[0]);
        expect(computeQuotedTextChecksum(one)).not.toBe(
          computeQuotedTextChecksum(other),
        );
      }
    });

    it('needs no placeholder: private-use characters in quoted text are kept as written', () => {
      const everyPrivateUse = Array.from(
        { length: 0xf8ff - 0xe000 + 1 },
        (_, offset) => String.fromCharCode(0xe000 + offset),
      ).join('');
      const sql = [`SELECT '${everyPrivateUse}', 'a  b'`];
      expect(normalizeSQLKeepingQuotedText(sql)).toBe(sql[0]);
    });
  });

  describe('checksums recorded by earlier releases', () => {
    /**
     * A record an earlier release wrote for these statements still verifies
     * (statement by statement and as one batch).
     */
    function expectEarlierRecordsVerify(statements: string[]) {
      expect(statements.length).toBeGreaterThan(0);
      const unverified = statements.filter(
        (sql) => !checksumMatchesRecorded([sql], computeChecksum([sql])),
      );
      expect(unverified).toEqual([]);
      expect(
        checksumMatchesRecorded(statements, computeChecksum(statements)),
      ).toBe(true);
    }

    it('verifies a record for every statement core generates for its fixture schemas', () => {
      const manifest = JSON.parse(
        readFileSync(
          join(CORE_ROOT, 'src/manifest/test-manifest.json'),
          'utf8',
        ),
      ) as { objects: Record<string, { schema?: SchemaDefinition }> };
      const schemas = Object.values(manifest.objects)
        .map((object) => object.schema)
        .filter(
          (schema): schema is SchemaDefinition =>
            !!schema?.tableName && !!schema.columns,
        );
      expect(schemas.length).toBeGreaterThan(100);
      for (const engine of ['sqlite', 'postgres', 'duckdb'] as const) {
        const strategy = getDDLStrategy(engine);
        const statements: string[] = [];
        for (const schema of schemas) {
          try {
            statements.push(
              strategy.generateCreateTable(schema),
              ...strategy.generateIndexes(schema),
              ...strategy.generateTriggers(schema),
            );
          } catch {
            // A fixture an engine refuses to render records nothing there.
          }
        }
        expectEarlierRecordsVerify(statements);
      }
    });

    it('verifies a record for every default, constraint and index of the saved release schemas', () => {
      const directory = join(CORE_ROOT, 'release-upgrade/snapshots');
      const files = readdirSync(directory).filter((file) =>
        file.endsWith('.json'),
      );
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const snapshot = JSON.parse(
          readFileSync(join(directory, file), 'utf8'),
        ) as {
          tables: Record<
            string,
            {
              columns: Record<string, { default: string | null; type: string }>;
              constraints: { definition: string }[];
              indexes: { definition: string }[];
            }
          >;
        };
        const statements: string[] = [];
        for (const [table, shape] of Object.entries(snapshot.tables)) {
          for (const [column, { default: value, type }] of Object.entries(
            shape.columns,
          )) {
            statements.push(
              `ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}${
                value === null ? '' : ` DEFAULT ${value}`
              }`,
            );
          }
          for (const { definition } of shape.constraints) {
            statements.push(`ALTER TABLE "${table}" ADD ${definition}`);
          }
          for (const { definition } of shape.indexes) {
            statements.push(definition);
          }
        }
        expectEarlierRecordsVerify(statements);
      }
    });

    it('verifies a record for statements with every quoting form, comments and the full private-use range', () => {
      const everyPrivateUse = Array.from(
        { length: 0xf8ff - 0xe000 + 1 },
        (_, offset) => String.fromCharCode(0xe000 + offset),
      ).join('');
      expectEarlierRecordsVerify([
        `SELECT '${everyPrivateUse}'`,
        "ALTER TABLE notes ALTER COLUMN label SET DEFAULT 'n/a  --  legacy'",
        "SELECT E'it\\'s --old'",
        'SELECT $$a--old$$, $fn$b  c$fn$',
        'SELECT `a  b`, [c  d], "e  f"',
        "UPDATE notes /* -- rationale */ SET label = 'old'",
        'SELECT /* a /* b */ c */ 1',
        "SELECT 'a\r\nb'",
        '',
      ]);
    });

    it('refuses a record written for different quoted text', () => {
      const recorded = computeQuotedTextChecksum([
        "ALTER TABLE notes ALTER COLUMN label SET DEFAULT 'n/a--legacy'",
      ]);
      expect(
        checksumMatchesRecorded(
          ["ALTER TABLE notes ALTER COLUMN label SET DEFAULT 'n/a--v2'"],
          recorded,
        ),
      ).toBe(false);
    });
  });
});
