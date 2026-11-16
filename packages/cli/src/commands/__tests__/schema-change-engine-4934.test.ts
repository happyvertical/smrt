/**
 * #4934 (review F3): `db:diff` and `db:status` decide every change with the
 * engine the database runs on, so a change the table of change kinds applies on
 * PostgreSQL (the shared-table CHECK) is shown there, and the same model on
 * SQLite shows what the table says for SQLite. No alteration may fall between
 * the three lists `db:diff` prints.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  ObjectRegistry,
  type SchemaDefinition,
} from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';

const { autoDiscoverAndLoadMock } = vi.hoisted(() => ({
  autoDiscoverAndLoadMock: vi.fn(),
}));
vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: autoDiscoverAndLoadMock,
}));

import { dbDiffCommand } from '../db-diff.js';
import {
  listAlteration,
  resolveSchemaChangeEngine,
  type SchemaChangeEngineName,
} from '../db-migrate-actions.js';
import { dbStatusCommand } from '../db-status.js';

type Engine = 'postgres' | 'sqlite';
const ENGINES: Engine[] = ['postgres', 'sqlite'];

const CHECK = {
  name: 'smrt_ck_doc_title_abcd1234',
  columns: ['title'],
  expression: `(_meta_type <> 'x:Strict') OR (title IS NOT NULL)`,
};

const table = (
  name: string,
  columns: SchemaDefinition['columns'],
  extra: Partial<SchemaDefinition> = {},
): SchemaDefinition => ({
  tableName: name,
  columns: { id: { type: 'TEXT', primaryKey: true }, ...columns },
  indexes: [],
  triggers: [],
  foreignKeys: [],
  dependencies: [],
  version: '4934',
  ...extra,
});

interface Scenario {
  name: string;
  table: string;
  column: string;
  /** Live statements per engine; the rows decide the kind of change. */
  setup: (engine: Engine) => string[];
  schema: SchemaDefinition;
  /** Only on PostgreSQL does the differ read table checks. */
  postgresOnly?: boolean;
}

const typeCol = { _meta_type: { type: 'TEXT' as const } };
const SCENARIOS: Scenario[] = [
  {
    name: 'set_not_null with no NULL rows',
    table: 't_notnull',
    column: 'v',
    setup: () => [
      'CREATE TABLE t_notnull (id TEXT PRIMARY KEY, v TEXT)',
      "INSERT INTO t_notnull VALUES ('a', 'x')",
    ],
    schema: table('t_notnull', { v: { type: 'TEXT', notNull: true } }),
  },
  {
    name: 'set_not_null blocked by NULL rows',
    table: 't_nulls',
    column: 'v',
    setup: () => [
      'CREATE TABLE t_nulls (id TEXT PRIMARY KEY, v TEXT)',
      "INSERT INTO t_nulls VALUES ('a', NULL)",
    ],
    schema: table('t_nulls', { v: { type: 'TEXT', notNull: true } }),
  },
  {
    name: 'drop_not_null',
    table: 't_dropnn',
    column: 'v',
    setup: () => [
      'CREATE TABLE t_dropnn (id TEXT PRIMARY KEY, v TEXT NOT NULL)',
    ],
    schema: table('t_dropnn', { v: { type: 'TEXT' } }),
  },
  {
    name: 'set_default',
    table: 't_setdef',
    column: 'v',
    setup: () => ['CREATE TABLE t_setdef (id TEXT PRIMARY KEY, v TEXT)'],
    schema: table('t_setdef', { v: { type: 'TEXT', defaultValue: 'x' } }),
  },
  {
    name: 'drop_default is reported until opted in',
    table: 't_dropdef',
    column: 'v',
    setup: () => [
      "CREATE TABLE t_dropdef (id TEXT PRIMARY KEY, v TEXT DEFAULT 'old')",
    ],
    schema: table('t_dropdef', { v: { type: 'TEXT' } }),
  },
  {
    name: 'set_check on a table missing the constraint',
    table: 't_check_add',
    column: 'title',
    postgresOnly: true,
    setup: () => [
      'CREATE TABLE t_check_add (id TEXT PRIMARY KEY, _meta_type TEXT, title TEXT)',
    ],
    schema: table(
      't_check_add',
      { ...typeCol, title: { type: 'TEXT' } },
      { checks: [CHECK] },
    ),
  },
  {
    name: 'set_check blocked by a row that breaks the rule',
    table: 't_check_bad',
    column: 'title',
    postgresOnly: true,
    setup: () => [
      'CREATE TABLE t_check_bad (id TEXT PRIMARY KEY, _meta_type TEXT, title TEXT)',
      "INSERT INTO t_check_bad VALUES ('a', 'x:Strict', NULL)",
    ],
    schema: table(
      't_check_bad',
      { ...typeCol, title: { type: 'TEXT' } },
      { checks: [CHECK] },
    ),
  },
  {
    name: 'drop_check for a constraint the model no longer declares',
    table: 't_check_drop',
    column: CHECK.name,
    postgresOnly: true,
    setup: () => [
      'CREATE TABLE t_check_drop (id TEXT PRIMARY KEY, _meta_type TEXT, title TEXT)',
      `ALTER TABLE t_check_drop ADD CONSTRAINT ${CHECK.name} CHECK (${CHECK.expression})`,
    ],
    schema: table('t_check_drop', {
      ...typeCol,
      title: { type: 'TEXT' },
    }),
  },
];

const HEADERS = {
  automatic: 'Column constraint repairs',
  manual: 'Column constraint drift needing a manual step',
  advisoryWarning: 'Live schema findings that need an operator decision',
  advisoryInfo: 'Live schema notes',
} as const;

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

function output(): string {
  return logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
}

async function configure(engine: Engine, scenarios: Scenario[]) {
  const live = scenarios.filter(
    (s) => engine === 'postgres' || !s.postgresOnly,
  );
  const url = join(dir, engine === 'postgres' ? 'pg-data' : 'live.db');
  const type = engine === 'postgres' ? 'pglite' : 'sqlite';
  const db = await getDatabase({ type, url } as never);
  for (const scenario of live)
    for (const sql of scenario.setup(engine)) await db.query(sql);
  await db.close?.();
  clearCache();
  setConfig({ packages: { cli: { database: { type, url } } } } as never);
  vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue(
    Object.fromEntries(live.map((s) => [s.table, s.schema])) as never,
  );
  return live;
}

/** The sections of the printed diff that mention `table.column`. */
function sectionsMentioning(out: string, subject: string): string[] {
  const starts = Object.entries(HEADERS)
    .map(([key, header]) => ({ key, at: out.indexOf(header) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at);
  const found: string[] = [];
  for (
    let from = out.indexOf(subject);
    from >= 0;
    from = out.indexOf(subject, from + subject.length)
  ) {
    const owner = [...starts].reverse().find((entry) => entry.at <= from);
    found.push(owner?.key ?? 'outside-every-list');
  }
  return [...new Set(found)];
}

beforeEach(() => {
  process.exitCode = undefined;
  dir = mkdtempSync(join(tmpdir(), 'engine-4934-'));
  autoDiscoverAndLoadMock.mockResolvedValue({
    discovered: [{ path: '/fake/.smrt/manifest.json', source: 'project' }],
    totalObjects: 1,
  });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  clearCache();
  rmSync(dir, { recursive: true, force: true });
});

describe('the engine a database type decides changes with', () => {
  it.each([
    ['postgres', 'postgres'],
    ['postgresql', 'postgres'],
    ['pg', 'postgres'],
    ['pglite', 'postgres'],
    ['duckdb', 'duckdb'],
    ['json', 'json'],
    ['sqlite', 'sqlite'],
  ])('%s decides as %s', (dbType, engine) => {
    expect(resolveSchemaChangeEngine(dbType)).toBe(engine);
  });
});

describe('a shared-table CHECK change is listed per engine (#4934)', () => {
  const missing = (): Parameters<typeof listAlteration>[0] => ({
    type: 'alter_column',
    table: 'docs',
    name: 'title',
    alteration: 'set_check',
    sqlStatements: ['ALTER TABLE docs ADD CONSTRAINT c CHECK (true)'],
  });
  const violated = (): Parameters<typeof listAlteration>[0] => ({
    type: 'alter_column',
    table: 'docs',
    name: 'title',
    alteration: 'set_check',
    sql: '-- docs.title holds NULL',
    advisory: { severity: 'warning', message: 'fill them' },
  });
  it.each<[SchemaChangeEngineName, string, string]>([
    ['postgres', 'automatic', 'manual'],
    ['sqlite', 'report', 'report'],
    ['duckdb', 'report', 'report'],
    ['json', 'report', 'report'],
  ])('on %s: missing is %s, violated is %s', (engine, add, bad) => {
    expect(listAlteration(missing(), engine)).toBe(add);
    expect(listAlteration(violated(), engine)).toBe(bad);
  });
});

describe.each(ENGINES)('db:diff and db:status on %s (#4934)', (engine) => {
  it('lists every alteration in exactly one of the three lists', async () => {
    const live = await configure(engine, SCENARIOS);
    await requireCommandHandler(dbDiffCommand)([], { verbose: true });
    const out = output();
    for (const scenario of live) {
      const subject = `${scenario.table}.${scenario.column}`;
      const sections = sectionsMentioning(out, subject);
      expect(
        sections,
        `${scenario.name}\n${out}\n${errSpy.mock.calls.join('\n')}`,
      ).toHaveLength(1);
      expect(sections[0]).not.toBe('outside-every-list');
    }
  });

  it('shows the pending CHECK in db:diff and db:status where the table applies it', async () => {
    const live = await configure(
      engine,
      SCENARIOS.filter((s) => s.name.startsWith('set_check on')),
    );
    if (engine === 'sqlite') {
      // SQLite carries no shared-table CHECK: nothing is read, nothing is
      // pending, and the status says in sync, as the table of kinds says.
      expect(live).toHaveLength(0);
      await requireCommandHandler(dbStatusCommand)([], { json: true });
      expect(JSON.parse(output()).drift).toEqual([]);
      return;
    }
    await requireCommandHandler(dbDiffCommand)([], {});
    expect(sectionsMentioning(output(), 't_check_add.title')).toEqual([
      'automatic',
    ]);
    logSpy.mockClear();
    await requireCommandHandler(dbStatusCommand)([], { json: true });
    const status = JSON.parse(output());
    expect(status.drift).toContainEqual(
      expect.objectContaining({
        name: 't_check_add.title',
        type: 'check_drift',
      }),
    );
  });

  it('reports a violated CHECK as a manual item and a dropped one as a repair', async () => {
    if (engine === 'sqlite') return;
    await configure(engine, SCENARIOS);
    await requireCommandHandler(dbDiffCommand)([], {});
    const out = output();
    expect(sectionsMentioning(out, 't_check_bad.title')).toEqual(['manual']);
    expect(sectionsMentioning(out, `t_check_drop.${CHECK.name}`)).toEqual([
      'automatic',
    ]);
  });
});
