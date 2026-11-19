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
  computeChecksum,
  computeQuotedTextChecksum,
  normalizeSQL,
  normalizeSQLKeepingQuotedText,
  shortChecksum,
  verifyChecksum,
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

    it('verifies a record the tracker writes now through checksumMatchesRecorded', () => {
      const recorded = computeQuotedTextChecksum(statements);
      expect(checksumMatchesRecorded(statements, recorded)).toBe(true);
      expect(
        checksumMatchesRecorded(
          ["UPDATE notes SET label = 'two spaces' WHERE label IS NULL"],
          recorded,
        ),
      ).toBe(false);
    });
  });

  describe('quoted text', () => {
    it.each([
      ['a comment marker', "'n/a--legacy'", "'n/a--v2'"],
      ['a block comment marker', "'a/*x*/b'", "'a/*y*/b'"],
      ['a run of spaces', "'x  y'", "'x y'"],
      ['a tab', "'x\ty'", "'x y'"],
      ['a line break', "'x\ny'", "'x y'"],
      ['an escaped quote before a marker', "'it''s --a'", "'it''s --b'"],
    ])('hashes two strings that differ only by %s differently', (_name, left, right) => {
      const one = [`UPDATE notes SET label = ${left} WHERE label IS NULL`];
      const other = [`UPDATE notes SET label = ${right} WHERE label IS NULL`];
      expect(normalizeSQLKeepingQuotedText(one)).toContain(left);
      expect(normalizeSQLKeepingQuotedText(other)).toContain(right);
      expect(computeQuotedTextChecksum(one)).not.toBe(
        computeQuotedTextChecksum(other),
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
      expect(computeQuotedTextChecksum(spread)).toBe(
        computeQuotedTextChecksum(compact),
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

    it('reads the same statement the same way whatever the line endings', () => {
      const unix = ["INSERT INTO notes (body) VALUES ('first\nsecond')"];
      const windows = ["INSERT INTO notes (body) VALUES ('first\r\nsecond')"];
      expect(computeQuotedTextChecksum(windows)).toBe(
        computeQuotedTextChecksum(unix),
      );
    });

    it('normalizes a dollar-quoted body as code and keeps the strings in it', () => {
      const one = [
        `DO $$
         BEGIN
           RAISE EXCEPTION 'two  spaces';
         END $$`,
      ];
      const sameLayoutChange = [
        "DO $$ BEGIN RAISE EXCEPTION 'two  spaces'; END $$",
      ];
      const otherText = ["DO $$ BEGIN RAISE EXCEPTION 'two spaces'; END $$"];
      expect(computeQuotedTextChecksum(one)).toBe(
        computeQuotedTextChecksum(sameLayoutChange),
      );
      expect(computeQuotedTextChecksum(one)).not.toBe(
        computeQuotedTextChecksum(otherText),
      );
    });

    it('survives an unterminated quote and a statement that uses the placeholder character', () => {
      expect(normalizeSQLKeepingQuotedText(["SELECT 'open  text"])).toBe(
        "SELECT 'open  text",
      );
      const privateUse = String.fromCharCode(0xe000);
      const sql = [`SELECT '${privateUse}0${privateUse}', 'a  b'`];
      expect(normalizeSQLKeepingQuotedText(sql)).toBe(sql[0]);
    });
  });

  describe('checksums recorded by earlier releases', () => {
    /**
     * Every statement in `statements` normalizes exactly as it did before
     * quoted text was respected, so its recorded checksum is unchanged.
     */
    function expectUnchanged(statements: string[]) {
      expect(statements.length).toBeGreaterThan(0);
      const changed = statements.filter(
        (sql) => normalizeSQLKeepingQuotedText([sql]) !== normalizeSQL([sql]),
      );
      expect(changed).toEqual([]);
      expect(computeQuotedTextChecksum(statements)).toBe(
        computeChecksum(statements),
      );
    }

    it('keeps the checksum of every statement core generates for its fixture schemas', () => {
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
        expectUnchanged(statements);
      }
    });

    it('keeps the checksum of every default, constraint and index of the saved release schemas', () => {
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
        expectUnchanged(statements);
      }
    });

    it('accepts the checksum an earlier release recorded for the same statements', () => {
      const statements = [
        "ALTER TABLE notes ALTER COLUMN label SET DEFAULT 'n/a  --  legacy'",
      ];
      const recordedByEarlierRelease = computeChecksum(statements);
      expect(recordedByEarlierRelease).not.toBe(
        computeQuotedTextChecksum(statements),
      );
      expect(
        checksumMatchesRecorded(statements, recordedByEarlierRelease),
      ).toBe(true);
      expect(
        checksumMatchesRecorded(
          statements,
          computeQuotedTextChecksum(statements),
        ),
      ).toBe(true);
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
