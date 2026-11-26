import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  ObjectRegistry,
  type SchemaDefinition,
} from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import { parseCliCommandArgs } from '../../cli-generator.js';
import { utilityCommands } from '../utilities.js';

const CANARY = 'canary_literal_5c27d1';

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: vi.fn(async () => ({
    discovered: [
      { path: '/fake/.smrt/manifest.json', source: 'project', objectCount: 1 },
    ],
    totalObjects: 1,
  })),
}));

// A driver that rejects statements carrying the canary and echoes the
// statement and its literal in its message, as PostgreSQL can.
vi.mock('@happyvertical/sql', async (importOriginal) => {
  const original = await importOriginal<typeof import('@happyvertical/sql')>();
  const echo =
    (query: (sql: string, ...values: unknown[]) => Promise<unknown>) =>
    async (sql: string, ...values: unknown[]) => {
      const flags = globalThis as {
        __failInit?: boolean;
        __failLedger?: boolean;
      };
      // A tracking-table DDL hook or a ledger trigger that echoes a value.
      if (
        (flags.__failInit &&
          /CREATE TABLE IF NOT EXISTS "?_smrt_schema_migrations/.test(sql)) ||
        (flags.__failLedger && sql.includes('INSERT INTO _smrt_migrate_runs'))
      ) {
        throw Object.assign(
          new Error('hook refused: token=canary_literal_5c27d1'),
          {
            context: {
              originalError: new Error('token=canary_literal_5c27d1'),
              sql: `${sql} -- canary_literal_5c27d1`,
            },
          },
        );
      }
      if (sql.includes('canary_literal_5c27d1')) {
        throw Object.assign(
          new Error(`syntax error at or near "canary_literal_5c27d1": ${sql}`),
          { code: '42601' },
        );
      }
      return query(sql, ...values);
    };
  return {
    ...original,
    getDatabase: async (...args: Parameters<typeof original.getDatabase>) => {
      const db = await original.getDatabase(...args);
      const transaction = db.transaction?.bind(db);
      db.query = echo(db.query.bind(db)) as typeof db.query;
      const execute = db.execute?.bind(db);
      if (execute)
        db.execute = ((strings: TemplateStringsArray, ...values: unknown[]) => {
          if (
            (globalThis as { __failLedger?: boolean }).__failLedger &&
            strings.join('?').includes('INSERT INTO _smrt_migrate_runs')
          )
            return Promise.reject(
              Object.assign(
                new Error('trigger refused: token=canary_literal_5c27d1'),
                {
                  context: {
                    originalError: new Error('token=canary_literal_5c27d1'),
                    sql: 'INSERT INTO _smrt_migrate_runs -- canary_literal_5c27d1',
                  },
                },
              ),
            );
          return execute(strings, ...values);
        }) as typeof db.execute;
      if (transaction)
        db.transaction = ((callback: (tx: DatabaseInterface) => unknown) =>
          transaction((tx) => {
            const wrapped = Object.create(tx) as DatabaseInterface;
            wrapped.query = echo(tx.query.bind(tx)) as typeof tx.query;
            return callback(wrapped) as Promise<never>;
          }).then((value) => {
            // A COMMIT that fails with the database's text (a deferred
            // constraint), after every statement of the body ran.
            if ((globalThis as { __failCommit?: boolean }).__failCommit)
              throw Object.assign(
                new Error(
                  'insert or update violates foreign key constraint: Key (owner)=(canary_literal_5c27d1) is not present in table "owners"',
                ),
                { code: '23503' },
              );
            return value;
          })) as typeof db.transaction;
      return db;
    },
  };
});

function schema(
  tableName: string,
  columns: SchemaDefinition['columns'],
): SchemaDefinition {
  return {
    tableName,
    columns,
    indexes: [],
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: '1',
  };
}

describe('db:migrate prints closed failure reasons', () => {
  let directory: string;
  let dbUrl: string;
  let output: string[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'migrate-redact-'));
    dbUrl = join(directory, 'test.db');
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
    });
    const schemas = {
      posts: schema('posts', {
        id: { type: 'TEXT', primaryKey: true },
        note: { type: 'TEXT', defaultValue: CANARY },
      }),
    };
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockImplementation(
      () => schemas,
    );
    vi.spyOn(ObjectRegistry, 'getInitializationOrder').mockReturnValue([
      'posts',
    ]);
    vi.spyOn(ObjectRegistry, 'getTableName').mockImplementation(
      (name: string) => name,
    );
    output = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(
          args
            .map((arg) =>
              typeof arg === 'string' ? arg : inspect(arg, { depth: 10 }),
            )
            .join(' '),
        );
      });
    process.exitCode = undefined;
  });
  afterEach(() => {
    (globalThis as { __failCommit?: boolean }).__failCommit = undefined;
    (globalThis as { __failInit?: boolean }).__failInit = undefined;
    (globalThis as { __failLedger?: boolean }).__failLedger = undefined;
    process.exitCode = undefined;
    clearCache();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps the authored literal and the driver text out of everything it prints', async () => {
    const command = utilityCommands['db:migrate'];
    const parsed = parseCliCommandArgs(['db:migrate'], [command]);
    await requireCommandHandler(command)(parsed.args, parsed.options);

    const printed = output.join('\n');
    expect(process.exitCode).toBe(1);
    expect(printed).toContain('SQLSTATE 42601');
    expect(printed).toContain('database message withheld');
    expect(printed).not.toContain(CANARY);
    expect(printed).not.toContain('syntax error');

    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    try {
      const rows = (
        await db.query(`SELECT error_message FROM _smrt_schema_migrations`)
      ).rows as Array<{ error_message: string | null }>;
      for (const row of rows)
        expect(row.error_message ?? '').not.toContain(CANARY);
    } finally {
      await db.close?.();
    }
  });

  it('prints only the closed reason when the batch fails at commit', async () => {
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockImplementation(
      () => ({
        posts: schema('posts', {
          id: { type: 'TEXT', primaryKey: true },
          note: { type: 'TEXT' },
        }),
      }),
    );
    (globalThis as { __failCommit?: boolean }).__failCommit = true;
    const command = utilityCommands['db:migrate'];
    const parsed = parseCliCommandArgs(['db:migrate', '--verbose'], [command]);
    await requireCommandHandler(command)(parsed.args, parsed.options);

    const printed = output.join('\n');
    expect(process.exitCode).toBe(1);
    expect(printed).toContain('failed in the commit phase (SQLSTATE 23503');
    expect(printed).not.toContain(CANARY);
    expect(printed).not.toContain('is not present in table');
  });

  const cleanSchema = () =>
    vi
      .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
      .mockImplementation(() => ({
        posts: schema('posts', {
          id: { type: 'TEXT', primaryKey: true },
          note: { type: 'TEXT' },
        }),
      }));

  it('prints only a closed reason when creating the tracking table fails', async () => {
    cleanSchema();
    (globalThis as { __failInit?: boolean }).__failInit = true;
    const command = utilityCommands['db:migrate'];
    const parsed = parseCliCommandArgs(['db:migrate'], [command]);
    await requireCommandHandler(command)(parsed.args, parsed.options);

    const printed = output.join('\n');
    expect(process.exitCode).toBe(1);
    expect(printed).toContain('database message withheld');
    expect(printed).not.toContain(CANARY);
    expect(printed).not.toContain('Failed SQL');
  });

  it('prints only a closed reason when recording the run fails', async () => {
    cleanSchema();
    (globalThis as { __failLedger?: boolean }).__failLedger = true;
    const command = utilityCommands['db:migrate'];
    const parsed = parseCliCommandArgs(['db:migrate'], [command]);
    await requireCommandHandler(command)(parsed.args, parsed.options);

    const printed = output.join('\n');
    expect(process.exitCode).toBe(1);
    expect(printed).toContain('recording the migrate run failed');
    expect(printed).toContain('confirmations from this run');
    expect(printed).toContain('must be recorded or audited by the operator');
    expect(printed).not.toContain(CANARY);
    expect(printed).not.toContain('Failed SQL');
  });
});
