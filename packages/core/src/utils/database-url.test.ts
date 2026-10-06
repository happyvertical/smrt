import { describe, expect, it } from 'vitest';
import {
  isSensitiveConnectionParam,
  redactDatabaseUrl,
  redactDatabaseUrlsInText,
} from './database-url';

const SECRET = 'S3NTINEL-pw';

describe('redactDatabaseUrl (#3527)', () => {
  it.each([
    [
      'postgres://anytown:S3NTINEL-pw@db.internal:5432/anytown',
      'postgres://anytown:***@db.internal:5432/anytown',
    ],
    [
      'postgresql://anytown:S3NTINEL-pw@db.internal:5432/anytown',
      'postgresql://anytown:***@db.internal:5432/anytown',
    ],
    [
      'postgresql://anytown:S3NTINEL-pw@db.internal/anytown',
      'postgresql://anytown:***@db.internal/anytown',
    ],
  ])('masks the password in %s', (input, expected) => {
    expect(redactDatabaseUrl(input)).toBe(expected);
  });

  it('keeps a URL with no password unchanged apart from the query', () => {
    expect(redactDatabaseUrl('postgresql://anytown@localhost:5432/db')).toBe(
      'postgresql://anytown@localhost:5432/db',
    );
    expect(redactDatabaseUrl('postgresql://localhost:5432/db')).toBe(
      'postgresql://localhost:5432/db',
    );
  });

  it('drops the whole query string and fragment', () => {
    const shown = redactDatabaseUrl(
      `postgresql://u:${SECRET}@h:5432/db?sslmode=require&password=${SECRET}&sslpassword=${SECRET}&sslkey=/etc/k.pem#${SECRET}`,
    );
    expect(shown).toBe('postgresql://u:***@h:5432/db');
  });

  it('masks a password given only in the query string', () => {
    expect(redactDatabaseUrl(`postgres://h/db?user=u&password=${SECRET}`)).toBe(
      'postgres://h/db',
    );
  });

  it('masks a percent-encoded special-character password', () => {
    expect(
      redactDatabaseUrl('postgresql://u:p%40ss%3Aw%2Ford@localhost:5432/db'),
    ).toBe('postgresql://u:***@localhost:5432/db');
  });

  it.each([
    ['unencoded #', 'postgresql://u:sup#er@localhost/db'],
    ['raw whitespace', 'postgresql://u:sup er@localhost/db'],
    ['literal @', 'postgres://u:pa#rt@secret@host/db'],
    ['empty username', 'postgres://:sec#ret@host/db'],
  ])('masks a malformed password (%s) without echoing it', (_label, input) => {
    const shown = redactDatabaseUrl(input);
    expect(shown).not.toMatch(/sup|er@|secret@|sec#|ret@|pa#rt/);
    expect(shown).toMatch(/^postgres(ql)?:\/\//);
  });

  it('never falls back to the raw string for an unparseable URL', () => {
    const input = `postgresql://u ser:${SECRET}@[bad-host/db`;
    const shown = redactDatabaseUrl(input);
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toBe(input);
    expect(shown.startsWith('postgresql://')).toBe(true);
  });

  it('never echoes userinfo the parser left in an opaque path', () => {
    const shown = redactDatabaseUrl(`user:${SECRET}@host/db`);
    expect(shown).not.toContain(SECRET);
  });

  it('keeps only safe keys of a libpq keyword DSN', () => {
    expect(
      redactDatabaseUrl(
        `host=db.internal port=5432 dbname=app user=u password='${SECRET} x' sslpassword=${SECRET}`,
      ),
    ).toBe('host=db.internal port=5432 dbname=app user=u');
  });

  it.each([
    './data/dev.db',
    '/var/lib/app/data.sqlite',
    ':memory:',
    'C:\\data\\dev.db',
  ])('leaves the SQLite/DuckDB path %s unchanged', (path) => {
    expect(redactDatabaseUrl(path)).toBe(path);
  });

  it('keeps a file URL path and drops its query', () => {
    expect(redactDatabaseUrl('file:///var/lib/app.db?mode=ro')).toBe(
      'file:///var/lib/app.db',
    );
  });

  it('returns an empty string for empty input', () => {
    expect(redactDatabaseUrl('')).toBe('');
  });
});

describe('redactDatabaseUrlsInText (#3527)', () => {
  it('masks a URL password embedded in an error message', () => {
    expect(
      redactDatabaseUrlsInText(
        `connect ECONNREFUSED: could not parse postgres://u:${SECRET}@localhost:5432/db as a connection string`,
      ),
    ).toBe(
      'connect ECONNREFUSED: could not parse postgres://u:***@localhost:5432/db as a connection string',
    );
  });

  it('masks secret query and keyword pairs, keeping the rest', () => {
    const text = `failed postgres://h/db?sslmode=require&sslpassword=${SECRET}&authToken=${SECRET} (password='${SECRET} x') pwd=${SECRET}`;
    const out = redactDatabaseUrlsInText(text);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('sslmode=require');
    expect(out).toContain('sslpassword=***');
    expect(out).toContain('authToken=***');
    expect(out).toContain('pwd=***');
  });

  it('over-redacts, never leaks, two DSNs on one line', () => {
    const out = redactDatabaseUrlsInText(
      'primary postgres://a:one@h1/d1 failed; fallback postgres://b:two@h2/d2',
    );
    expect(out).not.toMatch(/one|two/);
  });

  it('does not cross lines', () => {
    const text =
      'Invalid URL: postgres://host:5432/db\n    at admin@example.com';
    expect(redactDatabaseUrlsInText(text)).toBe(text);
  });

  it('leaves ordinary text alone and never throws', () => {
    expect(redactDatabaseUrlsInText('relation "w" does not exist')).toBe(
      'relation "w" does not exist',
    );
    expect(redactDatabaseUrlsInText('')).toBe('');
    expect(() => redactDatabaseUrlsInText('://not a url:::')).not.toThrow();
  });
});

describe('isSensitiveConnectionParam', () => {
  it.each([
    'password',
    'sslpassword',
    'PASSWORD',
    'authToken',
    'auth_token',
    'access-token',
    'api_key',
    'sslkey',
    'pwd',
    'client_secret',
    'connectionString',
  ])('treats %s as secret', (name) => {
    expect(isSensitiveConnectionParam(name)).toBe(true);
  });

  it.each([
    'sslmode',
    'host',
    'port',
    'dbname',
    'user',
    'application_name',
  ])('treats %s as safe', (name) => {
    expect(isSensitiveConnectionParam(name)).toBe(false);
  });
});
