import { describe, expect, it, vi } from 'vitest';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
  redactConnectionString,
  redactConnectionStringsInText,
} from '../db-command-utils.js';

describe('db command utilities', () => {
  describe('redactConnectionString', () => {
    it('redacts credentials in connection strings', () => {
      expect(
        redactConnectionString(
          'postgresql://anytown:super-secret@localhost:5432/anytown?sslmode=require&token=abc',
        ),
      ).toBe(
        'postgresql://anytown:***@localhost:5432/anytown?sslmode=require&token=***',
      );
    });

    it('leaves a connection string with no password unchanged', () => {
      expect(
        redactConnectionString('postgresql://anytown@localhost:5432/anytown'),
      ).toBe('postgresql://anytown@localhost:5432/anytown');
    });

    it('leaves a connection string with no userinfo at all unchanged', () => {
      expect(
        redactConnectionString('postgresql://localhost:5432/anytown'),
      ).toBe('postgresql://localhost:5432/anytown');
    });

    it('redacts a percent-encoded special-character password', () => {
      // 'p@ss:w/ord' percent-encoded.
      expect(
        redactConnectionString(
          'postgresql://anytown:p%40ss%3Aw%2Ford@localhost:5432/anytown',
        ),
      ).toBe('postgresql://anytown:***@localhost:5432/anytown');
    });

    it('redacts a password via the fallback regex when the value does not parse as a URL', () => {
      // An unencoded '#' truncates the URL parser's view of the string, so
      // this falls back to the userinfo regex rather than WHATWG URL parsing.
      expect(
        redactConnectionString('postgresql://anytown:sup#er@localhost/db'),
      ).toBe('postgresql://anytown:***@localhost/db');
    });

    it('redacts sensitive query parameters alongside the password', () => {
      expect(
        redactConnectionString(
          'postgresql://anytown:secret@localhost/db?apikey=xyz&other=keep',
        ),
      ).toBe('postgresql://anytown:***@localhost/db?apikey=***&other=keep');
    });

    it('leaves a plain non-connection-string value unchanged', () => {
      expect(redactConnectionString('./data/dev.db')).toBe('./data/dev.db');
    });
  });

  describe('redactConnectionStringsInText', () => {
    it('redacts a connection string embedded inside a larger error message', () => {
      expect(
        redactConnectionStringsInText(
          'connect ECONNREFUSED: could not parse postgres://anytown:super-secret@localhost:5432/anytown as a valid connection string',
        ),
      ).toBe(
        'connect ECONNREFUSED: could not parse postgres://anytown:***@localhost:5432/anytown as a valid connection string',
      );
    });

    it('redacts multiple connection strings and query-param secrets in one message', () => {
      const text =
        'primary postgres://a:one@host1/db1 failed; fallback postgres://b:two@host2/db2?token=abc also failed';
      expect(redactConnectionStringsInText(text)).toBe(
        'primary postgres://a:***@host1/db1 failed; fallback postgres://b:***@host2/db2?token=*** also failed',
      );
    });

    it('leaves ordinary error text with no embedded connection string unchanged', () => {
      const text = 'relation "widgets" does not exist';
      expect(redactConnectionStringsInText(text)).toBe(text);
    });

    it('leaves a stack trace with no embedded connection string unchanged', () => {
      const stack =
        'Error: column "foo" does not exist\n    at Object.query (/app/src/db.js:42:11)';
      expect(redactConnectionStringsInText(stack)).toBe(stack);
    });

    it('handles an empty string without throwing', () => {
      expect(redactConnectionStringsInText('')).toBe('');
    });

    it('never throws on malformed or unusual input', () => {
      expect(() =>
        redactConnectionStringsInText('://not a url at all:::'),
      ).not.toThrow();
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
