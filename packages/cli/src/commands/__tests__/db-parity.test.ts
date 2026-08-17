/**
 * Live-schema parity surfaces (#2368): `db:status --parity` and `doctor --db`.
 *
 * Both run against a REAL SQLite database. The point of the check is that it
 * catches drift the manifest-oracle diff cannot see, so these tests assert
 * against a database whose `db:status` drift list is empty while the live
 * schema is still wrong.
 */

import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  getSystemTableShapes,
  type LiveSchemaParityReport,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { autoDiscoverAndLoadMock } = vi.hoisted(() => ({
  autoDiscoverAndLoadMock: vi.fn(),
}));

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: autoDiscoverAndLoadMock,
}));

import {
  collectRegistryConflictTargets,
  formatParityReport,
  runLiveSchemaParity,
  selectFindings,
  summarizeParityReport,
} from '../db-parity.js';
import { dbStatusCommand } from '../db-status.js';
import { utilityCommands } from '../utilities.js';

const WIDGET_SCHEMA = {
  widgets: {
    tableName: 'widgets',
    columns: {
      id: { type: 'TEXT', primaryKey: true, referenceKind: 'id' },
      slug: { type: 'TEXT' },
      context: { type: 'TEXT' },
      tenant_id: { type: 'TEXT', referenceKind: 'tenantId' },
    },
    indexes: [],
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: '1.0.0',
  },
};

function report(
  overrides: Partial<LiveSchemaParityReport> = {},
): LiveSchemaParityReport {
  return {
    engine: 'sqlite',
    tablesChecked: 1,
    tablesMissing: 0,
    systemTablesIncluded: true,
    indexIntrospection: 'full',
    findings: [],
    counts: { error: 0, warning: 0, info: 0 },
    ok: true,
    ...overrides,
  };
}

describe('formatParityReport', () => {
  it('renders a clean report', () => {
    expect(formatParityReport(report()).join('\n')).toContain(
      '✅ Live schema matches the expected shape',
    );
  });

  it('hides informational findings unless verbose', () => {
    const withInfo = report({
      counts: { error: 0, warning: 0, info: 1 },
      findings: [
        {
          kind: 'extra_table',
          severity: 'info',
          table: 'leftovers',
          origin: 'application',
          message: 'Live table `leftovers` is not covered.',
          recommendation: 'Confirm ownership.',
        },
      ],
    });

    const quiet = formatParityReport(withInfo).join('\n');
    expect(quiet).not.toContain('leftovers');
    expect(quiet).toContain('1 informational finding(s) hidden');

    const verbose = formatParityReport(withInfo, { verbose: true }).join('\n');
    expect(verbose).toContain('leftovers');
    expect(verbose).toContain('→ Confirm ownership.');
  });

  it('says so when index metadata could not be read', () => {
    expect(
      formatParityReport(report({ indexIntrospection: 'unavailable' })).join(
        '\n',
      ),
    ).toContain('Index metadata is not readable');
  });

  it('orders findings by table then target and summarizes counts', () => {
    const messy = report({
      ok: false,
      counts: { error: 2, warning: 0, info: 0 },
      findings: [
        {
          kind: 'missing_column',
          severity: 'error',
          table: 'zebras',
          target: 'stripes',
          origin: 'application',
          message: 'zebras.stripes',
          recommendation: 'migrate',
        },
        {
          kind: 'missing_column',
          severity: 'error',
          table: 'apples',
          target: 'core',
          origin: 'application',
          message: 'apples.core',
          recommendation: 'migrate',
        },
      ],
    });

    expect(
      selectFindings(messy, 'error').map((finding) => finding.table),
    ).toEqual(['apples', 'zebras']);
    expect(summarizeParityReport(messy)).toBe(
      '2 error(s), 0 warning(s), 0 informational',
    );
  });
});

describe('collectRegistryConflictTargets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps every registered class onto its table conflict target', () => {
    vi.spyOn(ObjectRegistry, 'getQualifiedClassNames').mockReturnValue([
      '@app:Widget',
      '@app:Gadget',
    ]);
    vi.spyOn(ObjectRegistry, 'getTableName').mockImplementation((name) =>
      name === '@app:Widget' ? 'widgets' : 'gadgets',
    );
    vi.spyOn(ObjectRegistry, 'getConflictColumns').mockImplementation((name) =>
      name === '@app:Widget' ? ['slug', 'context'] : ['tenant_id', 'code'],
    );

    expect(collectRegistryConflictTargets()).toEqual({
      widgets: [{ columns: ['slug', 'context'], source: '@app:Widget' }],
      gadgets: [{ columns: ['tenant_id', 'code'], source: '@app:Gadget' }],
    });
  });

  it('skips classes with no table or no conflict columns', () => {
    vi.spyOn(ObjectRegistry, 'getQualifiedClassNames').mockReturnValue([
      '@app:Abstract',
      '@app:Empty',
    ]);
    vi.spyOn(ObjectRegistry, 'getTableName').mockImplementation((name) =>
      name === '@app:Abstract' ? undefined : 'empties',
    );
    vi.spyOn(ObjectRegistry, 'getConflictColumns').mockReturnValue([]);

    expect(collectRegistryConflictTargets()).toEqual({});
  });
});

describe('live parity against a real SQLite database', () => {
  let dbUrl: string;
  let getSchemasSpy: ReturnType<typeof vi.spyOn>;

  async function withDatabase(
    run: (db: Awaited<ReturnType<typeof getDatabase>>) => Promise<void>,
  ): Promise<void> {
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    try {
      await run(db);
    } finally {
      await db.close?.();
    }
  }

  async function createSystemTables(): Promise<void> {
    await withDatabase(async (db) => {
      for (const shape of getSystemTableShapes('sqlite').values()) {
        const columns = shape.columns
          .map(
            (column) =>
              `${column.name} ${column.type}${column.primaryKey ? ' PRIMARY KEY' : ''}${
                column.notNull ? ' NOT NULL' : ''
              }${column.unique ? ' UNIQUE' : ''}`,
          )
          .concat(
            shape.uniqueConstraints.map(
              (columnSet) => `UNIQUE(${columnSet.join(', ')})`,
            ),
          )
          .join(', ');
        await db.query(`CREATE TABLE ${shape.tableName} (${columns})`);
        for (const index of shape.indexes) {
          await db.query(
            `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${index.name} ON ${shape.tableName}(${index.columns.join(', ')})${
              index.where ? ` WHERE ${index.where}` : ''
            }`,
          );
        }
      }
    });
  }

  beforeEach(() => {
    process.exitCode = undefined;
    dbUrl = join(
      tmpdir(),
      `parity-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
    } as never);
    autoDiscoverAndLoadMock.mockResolvedValue({
      discovered: [],
      totalObjects: 0,
    });
    getSchemasSpy = vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions');
    getSchemasSpy.mockReturnValue(WIDGET_SCHEMA as never);
    vi.spyOn(ObjectRegistry, 'getQualifiedClassNames').mockReturnValue([
      '@app:Widget',
    ]);
    vi.spyOn(ObjectRegistry, 'getTableName').mockReturnValue('widgets');
    vi.spyOn(ObjectRegistry, 'getConflictColumns').mockReturnValue([
      'slug',
      'context',
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearCache();
    process.exitCode = undefined;
    rmSync(dbUrl, { force: true });
  });

  it('reports drift that the manifest diff calls "in sync"', async () => {
    await withDatabase(async (db) => {
      await db.query(
        'CREATE TABLE widgets (id TEXT PRIMARY KEY, slug TEXT, context TEXT, tenant_id TEXT)',
      );
      await db.query(
        'CREATE INDEX widgets_slug_context_idx ON widgets(slug, context)',
      );
    });
    await createSystemTables();

    const { report: parity, error } = await runLiveSchemaParity();

    expect(error).toBeNull();
    // The manifest declares no indexes at all, so the differ sees nothing.
    // The parity policy still sees a non-unique conflict target and an
    // unindexed tenant column.
    expect(
      selectFindings(parity as LiveSchemaParityReport, 'error').map(
        (finding) => finding.kind,
      ),
    ).toContain('conflict_target_not_unique');
    expect(
      selectFindings(parity as LiveSchemaParityReport, 'warning').map(
        (finding) => finding.target,
      ),
    ).toContain('tenant_id');
    expect(parity?.systemTablesIncluded).toBe(true);
  });

  it('fails closed when no persistent database is configured', async () => {
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: ':memory:' } } },
    } as never);

    const outcome = await runLiveSchemaParity();

    expect(outcome.report).toBeNull();
    expect(outcome.error).toContain('No persistent database is configured');
  });

  it('db:status --parity prints findings and exits non-zero', async () => {
    await withDatabase(async (db) => {
      await db.query('CREATE TABLE widgets (id TEXT PRIMARY KEY, slug TEXT)');
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await dbStatusCommand.handler([], { parity: true, verbose: true });
    const output = logSpy.mock.calls.flat().join('\n');

    expect(output).toContain('Live Schema Parity');
    expect(output).toContain('_smrt_changes');
    expect(output).toContain('widgets.context');
    expect(process.exitCode).toBe(1);
  });

  it('db:status --json carries the parity report', async () => {
    await withDatabase(async (db) => {
      await db.query(
        'CREATE TABLE widgets (id TEXT PRIMARY KEY, slug TEXT, context TEXT, tenant_id TEXT)',
      );
      await db.query(
        'CREATE UNIQUE INDEX widgets_slug_context_idx ON widgets(slug, context)',
      );
      await db.query(
        'CREATE INDEX widgets_tenant_id_idx ON widgets(tenant_id)',
      );
    });
    await createSystemTables();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await dbStatusCommand.handler([], { json: true, parity: true });
    const payload = JSON.parse(logSpy.mock.calls.flat().join('\n'));

    expect(payload.parity.ok).toBe(true);
    expect(payload.parity.findings).toEqual([]);
    expect(payload.parityError).toBeNull();
  });

  it('db:status without --parity leaves the parity block empty', async () => {
    await withDatabase(async (db) => {
      await db.query('CREATE TABLE widgets (id TEXT PRIMARY KEY, slug TEXT)');
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await dbStatusCommand.handler([], { json: true });
    const payload = JSON.parse(logSpy.mock.calls.flat().join('\n'));

    expect(payload.parity).toBeNull();
    expect(payload.parityError).toBeNull();
  });

  describe('doctor --db', () => {
    const tempDirs: string[] = [];
    const originalCwd = process.cwd();

    afterEach(async () => {
      process.chdir(originalCwd);
      for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
      }
    });

    async function enterProject(): Promise<void> {
      const projectDir = await mkdtemp(
        resolve(originalCwd, '.tmp-smrt-doctor-db-'),
      );
      tempDirs.push(projectDir);
      await writeFile(
        resolve(projectDir, 'package.json'),
        JSON.stringify({
          name: 'parity-fixture',
          private: true,
          dependencies: { '@happyvertical/smrt-core': '0.0.0-test' },
        }),
      );
      process.chdir(projectDir);
    }

    it('reports live-schema errors as doctor issues', async () => {
      await withDatabase(async (db) => {
        await db.query('CREATE TABLE widgets (id TEXT PRIMARY KEY, slug TEXT)');
      });
      await enterProject();

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
        code?: string | number | null,
      ) => {
        throw new Error(`exit:${code ?? ''}`);
      }) as typeof process.exit);

      await expect(
        utilityCommands.doctor.handler([], { db: true }),
      ).rejects.toThrow('exit:1');

      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Live Database Parity');
      expect(output).toContain('live schema: _smrt_contexts (missing_table)');

      exitSpy.mockRestore();
    });

    it('does not open a database when --db is absent', async () => {
      await enterProject();

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
        code?: string | number | null,
      ) => {
        throw new Error(`exit:${code ?? ''}`);
      }) as typeof process.exit);

      await utilityCommands.doctor.handler([], {}).catch(() => undefined);

      expect(logSpy.mock.calls.flat().join('\n')).not.toContain(
        'Live Database Parity',
      );

      exitSpy.mockRestore();
    });
  });
});
