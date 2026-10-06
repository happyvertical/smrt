import { describe, expect, it, vi } from 'vitest';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
  redactDatabaseUrl,
  redactDatabaseUrlsInText,
} from '../db-command-utils.js';

describe('db command utilities', () => {
  describe('redactDatabaseUrl', () => {
    it('is the smrt-core helper, so the CLI has one redaction path (#3527)', async () => {
      const core = await import('@happyvertical/smrt-core');
      const subpath = await import(
        '@happyvertical/smrt-core/utils/database-url'
      );
      expect(core.redactDatabaseUrl).toBe(subpath.redactDatabaseUrl);
      expect(redactDatabaseUrl).toBe(core.redactDatabaseUrl);
      expect(redactDatabaseUrlsInText).toBe(core.redactDatabaseUrlsInText);
    });
  });

  describe('formatDatabaseDisplayUrl (the connect banner, #3527)', () => {
    it.each([
      [
        'postgres',
        'postgres://owner:SENTINEL-7731@db.internal:5432/app',
        'postgres://owner:***@db.internal:5432/app',
      ],
      [
        'postgres',
        'postgresql://owner:SENTINEL-7731@db.internal:5432/app?sslmode=require&password=SENTINEL-7731&sslpassword=SENTINEL-7731',
        'postgresql://owner:***@db.internal:5432/app',
      ],
      [
        'postgres',
        'postgresql://owner:p%40ss%3ASENTINEL-7731@db.internal/app',
        'postgresql://owner:***@db.internal/app',
      ],
      [
        'postgres',
        'host=db.internal port=5432 dbname=app user=owner password=SENTINEL-7731',
        'host=db.internal port=5432 dbname=app user=owner',
      ],
      ['sqlite', './data/dev.db', 'sqlite://./data/dev.db'],
      ['sqlite', ':memory:', 'sqlite://:memory:'],
      [
        'duckdb',
        '/var/lib/app/data.duckdb',
        'duckdb:///var/lib/app/data.duckdb',
      ],
    ])('renders %s %s without secrets', (dbType, url, expected) => {
      const banner = `✓ Connected to ${formatDatabaseDisplayUrl(dbType, url)}`;
      expect(banner).toBe(`✓ Connected to ${expected}`);
      expect(banner).not.toContain('SENTINEL');
    });

    it.each([
      'postgresql://owner:SENTINEL#7731@db.internal/app',
      'postgresql://owner:SENTINEL 7731@db.internal/app',
      'postgresql://owner:SENTINEL@7731@db.internal/app',
      'postgresql://ow ner:SENTINEL-7731@[db.internal/app',
    ])('never prints a malformed URL raw: %s', (url) => {
      const shown = formatDatabaseDisplayUrl('postgres', url);
      expect(shown).not.toContain('SENTINEL');
      expect(shown).not.toContain('7731');
      expect(shown.startsWith('postgresql://')).toBe(true);
    });
  });

  describe('redactDatabaseUrlsInText', () => {
    it('redacts a connection string embedded inside a larger error message', () => {
      expect(
        redactDatabaseUrlsInText(
          'connect ECONNREFUSED: could not parse postgres://anytown:super-secret@localhost:5432/anytown as a valid connection string',
        ),
      ).toBe(
        'connect ECONNREFUSED: could not parse postgres://anytown:***@localhost:5432/anytown as a valid connection string',
      );
    });

    it('redacts multiple connection strings and query-param secrets in one message', () => {
      const text =
        'primary postgres://a:one@host1/db1 failed\nfallback postgres://b:two@host2/db2?token=abc also failed';
      expect(redactDatabaseUrlsInText(text)).toBe(
        'primary postgres://a:***@host1/db1 failed\nfallback postgres://b:***@host2/db2?token=*** also failed',
      );
    });

    it('over-redacts, never leaks, when two connection strings share a line (#2985)', () => {
      const redacted = redactDatabaseUrlsInText(
        'primary postgres://a:one@host1/db1 failed; fallback postgres://b:two@host2/db2?token=abc',
      );
      expect(redacted).toBe('primary postgres://a:***@host2/db2?token=***');
      expect(redacted).not.toMatch(/one|two|abc/);
    });

    it('redacts a password mixing a literal "@" with scheme-like text (#2985)', () => {
      expect(
        redactDatabaseUrlsInText(
          'TypeError: Invalid URL: postgres://user:secret@https://suffix@host/db',
        ),
      ).toBe('TypeError: Invalid URL: postgres://user:***@host/db');
    });

    it('leaves ordinary error text with no embedded connection string unchanged', () => {
      const text = 'relation "widgets" does not exist';
      expect(redactDatabaseUrlsInText(text)).toBe(text);
    });

    it('leaves a stack trace with no embedded connection string unchanged', () => {
      const stack =
        'Error: column "foo" does not exist\n    at Object.query (/app/src/db.js:42:11)';
      expect(redactDatabaseUrlsInText(stack)).toBe(stack);
    });

    it('handles an empty string without throwing', () => {
      expect(redactDatabaseUrlsInText('')).toBe('');
    });

    it('never throws on malformed or unusual input', () => {
      expect(() =>
        redactDatabaseUrlsInText('://not a url at all:::'),
      ).not.toThrow();
    });

    it('redacts an empty-username connection string embedded in error text', () => {
      expect(
        redactDatabaseUrlsInText(
          'TypeError: Invalid URL: postgres://:secret@host:5432/db',
        ),
      ).toBe('TypeError: Invalid URL: postgres://:***@host:5432/db');
    });

    it('redacts the whole password, including a literal "@", embedded in error text', () => {
      expect(
        redactDatabaseUrlsInText(
          'TypeError: Invalid URL: postgres://user:part@secret@host/db',
        ),
      ).toBe('TypeError: Invalid URL: postgres://user:***@host/db');
    });

    it('redacts a password containing raw whitespace through the next "@" (#2985)', () => {
      expect(
        redactDatabaseUrlsInText(
          'TypeError: Invalid URL: postgres://user:secret pass@host/db',
        ),
      ).toBe('TypeError: Invalid URL: postgres://user:***@host/db');
    });

    it('redacts a password containing both raw whitespace and a literal "@" (#2985)', () => {
      expect(
        redactDatabaseUrlsInText(
          'TypeError: Invalid URL: postgres://user:sec ret@pa ss@word@host/db',
        ),
      ).toBe('TypeError: Invalid URL: postgres://user:***@host/db');
      expect(
        redactDatabaseUrlsInText(
          'TypeError: Invalid URL: postgres://user:secret pass@word@host/db',
        ),
      ).toBe('TypeError: Invalid URL: postgres://user:***@host/db');
    });

    it('redacts a password containing scheme-like text (#2985)', () => {
      expect(
        redactDatabaseUrlsInText(
          'TypeError: Invalid URL: postgres://user:secret:https://suffix@host/db',
        ),
      ).toBe('TypeError: Invalid URL: postgres://user:***@host/db');
      expect(
        redactDatabaseUrlsInText(
          'TypeError: Invalid URL: postgres://user:se cret:https://suffix@host/db',
        ),
      ).toBe('TypeError: Invalid URL: postgres://user:***@host/db');
    });

    it('never lets a whitespace-bearing password span into the next line (#2985)', () => {
      expect(
        redactDatabaseUrlsInText(
          'Invalid URL: postgres://host:5432/db\n    at admin@example.com',
        ),
      ).toBe('Invalid URL: postgres://host:5432/db\n    at admin@example.com');
    });
  });

  it('formats relative database paths without leaking credentials', () => {
    expect(formatDatabaseDisplayUrl('sqlite', './data/dev.db')).toBe(
      'sqlite://./data/dev.db',
    );
  });

  it('redacts a password when formatting a full database display URL', () => {
    expect(
      formatDatabaseDisplayUrl(
        'postgres',
        'postgres://anytown:s3cr3t@localhost:5432/anytown',
      ),
    ).toBe('postgres://anytown:***@localhost:5432/anytown');
  });

  it('closes database handles when commands finish', async () => {
    const close = vi.fn();

    await closeDatabaseConnection({ close });

    expect(close).toHaveBeenCalledOnce();
  });
});
