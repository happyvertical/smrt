/**
 * Reading a PostgreSQL CREATE INDEX statement as the server reads it: the
 * lexical cases, the index name and table as PostgreSQL stores them, and
 * every case that must be read as "not certain" rather than guessed.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyIndexStatement,
  normalizePostgresIdentifier,
  readCreateIndexStatement,
  readPostgresTokens,
} from '../postgres-create-index.js';

const read = (sql: string) => {
  const reading = readCreateIndexStatement(sql);
  return reading.kind === 'create-index'
    ? { name: reading.statement.name, relation: reading.statement.relation }
    : reading.kind;
};

describe('the PostgreSQL lexer', () => {
  it('ends a -- comment at LF or at CR', () => {
    expect(readPostgresTokens('a -- one\nb -- two\rc')).toEqual([
      { kind: 'word', value: 'a' },
      { kind: 'word', value: 'b' },
      { kind: 'word', value: 'c' },
    ]);
  });

  it('reads nested block comments as one separator', () => {
    expect(readPostgresTokens('a /* x /* y */ still */ b')).toEqual([
      { kind: 'word', value: 'a' },
      { kind: 'word', value: 'b' },
    ]);
  });

  it.each([
    ["'a -- not a comment /* nor this'", 'a single-quoted string'],
    ["'it''s'", 'a doubled quote'],
    ["E'it\\'s -- still /* text'", 'an E string with a backslash escape'],
    ["e'\\\\'", 'an e string ending in an escaped backslash'],
    ['$$ -- not a comment $$', 'an empty-tag dollar string'],
    ['$fn$ /* not a comment $fn$', 'a tagged dollar string'],
    ["X'1F'", 'a hex string'],
  ])('reads %s whole (%s)', (literal) => {
    expect(readPostgresTokens(`a ${literal} b`)).toEqual([
      { kind: 'word', value: 'a' },
      { kind: 'string' },
      { kind: 'word', value: 'b' },
    ]);
  });

  it('keeps a double-quoted identifier as written, with "" as a quote', () => {
    expect(readPostgresTokens('"Mixed ""Name"""')).toEqual([
      { kind: 'quoted', value: 'Mixed "Name"' },
    ]);
  });

  it("uses PostgreSQL's whitespace only: U+00A0 belongs to a bare identifier", () => {
    expect(readPostgresTokens('a\u00a0b \u00a0c\v\fd')).toEqual([
      { kind: 'word', value: 'a\u00a0b' },
      { kind: 'word', value: '\u00a0c' },
      { kind: 'word', value: 'd' },
    ]);
  });

  it('folds an unquoted identifier to lower case, ASCII only', () => {
    expect(readPostgresTokens('MixedCase Ärger')).toEqual([
      { kind: 'word', value: 'mixedcase' },
      { kind: 'word', value: 'Ärger' },
    ]);
  });

  it('truncates names to 63 bytes, quoted or not, on a character boundary', () => {
    expect(normalizePostgresIdentifier('A'.repeat(70), false)).toBe(
      'a'.repeat(63),
    );
    expect(normalizePostgresIdentifier('é'.repeat(40), true)).toBe(
      'é'.repeat(31),
    );
  });

  it.each([
    ["'open", 'an unterminated string'],
    ['"open', 'an unterminated quoted identifier'],
    ['/* open', 'an unterminated comment'],
    ['$tag$ open', 'an unterminated dollar string'],
    ['U&"d\\0061t"', 'a Unicode-escaped identifier'],
  ])('reports %s as unreadable (%s)', (sql) => {
    expect(readPostgresTokens(sql)).toHaveProperty('unreadable');
  });
});

describe('reading a CREATE INDEX statement', () => {
  it.each([
    ['CREATE INDEX idx ON jobs (status)', 'idx', ['jobs']],
    [
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Idx" ON app."Jobs" ("status")',
      'Idx',
      ['app', 'Jobs'],
    ],
    [
      'CREATE INDEX idx_Orders_Date ON Orders (created_at)',
      'idx_orders_date',
      ['orders'],
    ],
    ['/* why */ CREATE INDEX idx ON jobs (status)', 'idx', ['jobs']],
    ['-- why\r\nCREATE INDEX idx ON jobs (status)', 'idx', ['jobs']],
    [
      'CREATE INDEX idx ON -- note\r app.jobs (\n lower(status))',
      'idx',
      ['app', 'jobs'],
    ],
    [
      'CREATE INDEX idx ON appusing /* c */ . jobs (status)',
      'idx',
      ['appusing', 'jobs'],
    ],
    ['CREATE INDEX idx ON ONLY jobs USING btree (status)', 'idx', ['jobs']],
    [
      "CREATE INDEX idx ON jobs (status) WHERE status <> '/*' AND note <> E'\\''",
      'idx',
      ['jobs'],
    ],
    [
      'CREATE INDEX idx ON jobs (status) WHERE note <> $$ /* $$',
      'idx',
      ['jobs'],
    ],
    [
      `CREATE INDEX ${'Long'.repeat(20)} ON jobs (status)`,
      'long'.repeat(20).slice(0, 63),
      ['jobs'],
    ],
  ])('reads %s', (sql, name, relation) => {
    expect(read(sql)).toEqual({ name, relation });
  });

  it('reads a schema name that starts with U+00A0 as PostgreSQL does', () => {
    expect(read('CREATE INDEX idx ON \u00a0app.jobs (status)')).toEqual({
      name: 'idx',
      relation: ['\u00a0app', 'jobs'],
    });
  });

  it('reads the parts the check compares: method, keys, include, nulls, predicate', () => {
    const reading = readCreateIndexStatement(
      'CREATE UNIQUE INDEX i ON t USING btree (a COLLATE "C" text_pattern_ops DESC, (lower(b)) NULLS FIRST) INCLUDE (c) NULLS NOT DISTINCT WITH (fillfactor = 70) WHERE d IS NOT NULL;',
    );
    expect(reading.kind).toBe('create-index');
    const statement = (
      reading as unknown as { statement: Record<string, unknown> }
    ).statement;
    expect(statement).toMatchObject({
      unique: true,
      method: 'btree',
      include: ['c'],
      nullsNotDistinct: true,
      predicate: 'd IS NOT NULL',
      keys: [
        {
          column: 'a',
          expression: null,
          collation: ['C'],
          opclass: ['text_pattern_ops'],
          descending: true,
          nullsFirst: true,
        },
        {
          column: null,
          expression: '(lower(b))',
          collation: null,
          opclass: null,
          descending: false,
          nullsFirst: true,
        },
      ],
    });
  });

  it('reads an unnamed index as unnamed, not as an index called ON', () => {
    expect(read('CREATE INDEX CONCURRENTLY ON jobs (status)')).toEqual({
      name: null,
      relation: ['jobs'],
    });
  });

  it('quotes the table reference as PostgreSQL stores it', () => {
    const reading = readCreateIndexStatement(
      'CREATE INDEX idx ON App.Jobs (status)',
    );
    expect(
      reading.kind === 'create-index' && reading.statement.relationSql,
    ).toBe('"app"."jobs"');
  });

  it.each([
    'CREATE INDEX idx ON db.app.jobs (status)',
    'CREATE INDEX idx ON U&"jobs" (status)',
    'CREATE INDEX idx ON jobs WHERE (status)',
    'CREATE INDEX IF NOT EXISTS ON jobs (status)',
    'CREATE INDEX idx ON /* open (status)',
    "CREATE INDEX idx ON 'jobs' (status)",
  ])('does not guess at %s', (sql) => {
    expect(read(sql)).toBe('unreadable');
  });

  it.each([
    'DROP INDEX idx',
    'ALTER TABLE t ADD COLUMN a TEXT',
    'CREATE TABLE t (a int)',
  ])('reads %s as no CREATE INDEX', (sql) => {
    expect(read(sql)).toBe('not-create-index');
  });
});

describe('index statements whose name cannot be read', () => {
  it.each([
    ['CREATE INDEX U&"jobs_idx" ON jobs (status)', 'create', false],
    ['CREATE UNIQUE INDEX U&"jobs_idx" ON jobs (status)', 'create', false],
    ['CREATE INDEX CONCURRENTLY U&"jobs_idx" ON jobs (status)', 'create', true],
    ['DROP INDEX U&"jobs_idx"', 'drop', false],
    ['DROP INDEX CONCURRENTLY IF EXISTS U&"jobs_idx"', 'drop', true],
  ])('keeps %s known as index DDL', (sql, index, concurrently) => {
    expect(classifyIndexStatement(sql)).toMatchObject({
      kind: 'unreadable',
      index,
      concurrently,
    });
  });

  it('reads no index DDL into a statement that is not one', () => {
    expect(classifyIndexStatement('CREATE TABLE U&"t" (a int)')).toEqual({
      kind: 'other',
    });
    expect(classifyIndexStatement('CREATE U&"t"')).toMatchObject({
      kind: 'unreadable',
      index: null,
    });
  });
});

describe('reading a partial index predicate', () => {
  it('keeps the predicate through the end of its last token, U+00A0 included', () => {
    const reading = readCreateIndexStatement(
      'CREATE UNIQUE INDEX jobs_idx ON jobs (id) WHERE active\u00a0',
    );
    expect(
      reading.kind === 'create-index' ? reading.statement.predicate : reading,
    ).toBe('active\u00a0');
  });

  it('starts the predicate at its first token and ends it before a semicolon', () => {
    const reading = readCreateIndexStatement(
      'CREATE INDEX jobs_idx ON jobs (id) WHERE  \t active ;',
    );
    expect(
      reading.kind === 'create-index' ? reading.statement.predicate : reading,
    ).toBe('active');
  });
});
