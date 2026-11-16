/** `db:migrate --confirm-recompute` and the doctor listing (#5018), real SQLite. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  ObjectRegistry,
  type SchemaDefinition,
  SmrtObject,
} from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import { parseCliCommandArgs } from '../../cli-generator.js';
import { buildMigratePreview } from '../doctor-migrate-preview.js';
import { utilityCommands } from '../utilities.js';

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: vi.fn(async () => ({
    discovered: [
      { path: '/fake/.smrt/manifest.json', source: 'project', objectCount: 1 },
    ],
    totalObjects: 1,
  })),
}));

const doubled = {
  op: 'mul',
  left: { col: 'qty' },
  right: { value: 2 },
} as unknown as NonNullable<SchemaDefinition['columns'][string]['generated']>;

describe('db:migrate --confirm-recompute (#5018)', () => {
  let directory: string;
  let dbUrl: string;
  let logs: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;

  async function withDb<T>(
    work: (db: DatabaseInterface) => Promise<T>,
  ): Promise<T> {
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    try {
      return await work(db);
    } finally {
      await db.close?.();
    }
  }
  async function run(...flags: string[]) {
    process.exitCode = undefined;
    logs.mockClear();
    errors.mockClear();
    const command = utilityCommands['db:migrate'];
    const parsed = parseCliCommandArgs(['db:migrate', ...flags], [command]);
    await requireCommandHandler(command)(parsed.args, parsed.options);
    return [...logs.mock.calls, ...errors.mock.calls]
      .map((call) => call.join(' '))
      .join('\n');
  }
  const stored = () =>
    withDb(
      async (db) =>
        (await db.query('SELECT id, total FROM items ORDER BY id')).rows,
    );

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'migrate-5018-'));
    dbUrl = join(directory, 'test.db');
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
    });
    const schema: SchemaDefinition = {
      tableName: 'items',
      columns: {
        id: { type: 'TEXT', primaryKey: true, notNull: true },
        qty: { type: 'INTEGER' },
        total: {
          type: 'INTEGER',
          generated: doubled,
          generatedInputTypes: { qty: 'number' },
        },
      },
      indexes: [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '5018',
    };
    vi.spyOn(ObjectRegistry, 'getAllClasses').mockReturnValue(
      new Map([
        [
          '@app/a:Item',
          {
            name: 'Item',
            constructor: SmrtObject,
            config: {},
            fields: new Map(),
            methods: new Map(),
          },
        ],
      ]),
    );
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockImplementation(
      () => ({ items: schema }),
    );
    vi.spyOn(ObjectRegistry, 'getInitializationOrder').mockReturnValue([
      'items',
    ]);
    vi.spyOn(ObjectRegistry, 'getTableName').mockImplementation(
      (name: string) => name,
    );
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withDb(async (db) => {
      await db.query(
        'CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, qty INTEGER, total INTEGER)',
      );
      await db.query(
        "INSERT INTO items VALUES ('a', 3, 6), ('b', 4, 99), ('c', 5, 10)",
      );
    });
  });
  afterEach(() => {
    process.exitCode = undefined;
    clearCache();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it('stops naming the count and the row, and `doctor --db` lists the same', async () => {
    const out = await run();
    expect(process.exitCode).toBe(1);
    expect(out).toContain('1 stored row(s)');
    expect(out).toContain('id=b: stored 99, computed 8');
    expect(out).toContain('--confirm-recompute items.total');
    expect(await stored()).toEqual([
      { id: 'a', total: 6 },
      { id: 'b', total: 99 },
      { id: 'c', total: 10 },
    ]);
    const report = await withDb((db) => buildMigratePreview(db, 'sqlite'));
    expect(report.stops.join('\n')).toContain(
      'column.generated-from-ordinary-differs (loses-data)',
    );
    expect(report.stops.join('\n')).toContain('1 differing row(s)');
    expect(report.stops.join('\n')).toContain('stored 99, computed 8');
  });

  it('recalculates on request and records it', async () => {
    const out = await run('--confirm-recompute', 'items.total');
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain('Recompute (--confirm-recompute): items.total');
    expect(await stored()).toEqual([
      { id: 'a', total: 6 },
      { id: 'b', total: 8 },
      { id: 'c', total: 10 },
    ]);
    const recorded = await withDb(
      async (db) =>
        (
          await db.query(
            'SELECT recomputes FROM _smrt_migrate_runs ORDER BY created_at DESC, id DESC LIMIT 1',
          )
        ).rows[0],
    );
    expect(JSON.parse(String(recorded.recomputes))).toEqual([
      { table: 'items', column: 'total', rows: 1 },
    ]);
  });

  it('applies unattended when no value changes, and ignores a confirmation that matches nothing', async () => {
    await withDb((db) => db.query("UPDATE items SET total = 8 WHERE id = 'b'"));
    const out = await run('--confirm-recompute', 'items.nope');
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain('Ignoring --confirm-recompute items.nope');
    expect(await stored()).toEqual([
      { id: 'a', total: 6 },
      { id: 'b', total: 8 },
      { id: 'c', total: 10 },
    ]);
    const recorded = await withDb(
      async (db) =>
        (
          await db.query(
            'SELECT recomputes FROM _smrt_migrate_runs ORDER BY created_at DESC, id DESC LIMIT 1',
          )
        ).rows[0],
    );
    expect(recorded.recomputes).toBeNull();
  });
});
