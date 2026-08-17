import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { MigrationTracker } from '@happyvertical/smrt-core/migrations';
import { getDatabase } from '@happyvertical/sql';
import { parseCliArgs } from '@happyvertical/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbRollbackCommand, recoverDownStatements } from '../db-rollback.js';

// The command prompts via node:readline/promises when not forced. Stub the
// module so the "confirm"/"decline" branches can be exercised deterministically
// without real stdin. The default answer ('y') keeps any forced-path tests
// unaffected since they never reach the prompt.
const questionMock = vi.fn(async () => 'y');
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: questionMock,
    close: vi.fn(),
  }),
}));

/**
 * db:rollback against a REAL SQLite database.
 *
 * The command opens its own connection from config (and closes it in a
 * `finally`), so each test uses a unique on-disk SQLite file that the command
 * and the test both open by URL — letting us pre-seed real migration history
 * with the real MigrationTracker, run the command, then re-open the file to
 * assert how it mutated the `_smrt_schema_migrations` rows *and* the schema.
 *
 * Regression contract for #2378: the command must never report a rollback it
 * did not perform. A migration whose DOWN script cannot be recovered is
 * refused (non-zero exit, row untouched); a `create_table_<table>` migration
 * has its recorded `DROP TABLE IF EXISTS "<table>"` actually executed; and the
 * old record-only flip survives only behind the explicit `--mark-only` flag,
 * which says in its own output that the schema was not changed.
 */
describe('db:rollback (real SQLite)', () => {
  let dbUrl: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  /**
   * Mirrors what `db:migrate` records for `diff.added_tables`: the name
   * `create_table_<table>` and the DOWN `DROP TABLE IF EXISTS "<table>"`.
   * This is the only migration class with a recoverable DOWN.
   */
  function createTableDef(table: string) {
    return {
      id: `create_table_${table}`,
      description: `Create table ${table}`,
      version: '1.0.0',
      up: [`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`],
      down: [`DROP TABLE IF EXISTS "${table}"`],
    };
  }

  /**
   * A reversible migration applied under a caller-chosen name: its DOWN SQL
   * lives nowhere in `_smrt_schema_migrations`, so the command cannot
   * reconstruct it.
   */
  function customReversibleDef(id: string, table: string) {
    return {
      id,
      description: `Migration ${id}`,
      version: '1.0.0',
      up: [`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`],
      down: [`DROP TABLE IF EXISTS "${table}"`],
    };
  }

  /** What every non-`create_table_*` auto-migration looks like: no DOWN. */
  function nonReversibleDef(id: string) {
    return {
      id,
      description: `Migration ${id}`,
      version: '1.0.0',
      up: [`CREATE TABLE ${id} (id TEXT PRIMARY KEY)`],
      down: [],
    };
  }

  async function freshDb(): Promise<any> {
    return getDatabase({ type: 'sqlite', url: dbUrl });
  }

  async function seedMigrations(
    defs: Array<ReturnType<typeof createTableDef>>,
  ): Promise<void> {
    const db = await freshDb();
    const tracker = new MigrationTracker({ db });
    await tracker.initialize();
    for (const def of defs) {
      await tracker.apply(def);
    }
    await db.close?.();
  }

  async function readHistory(): Promise<
    Array<{ name: string; status: string }>
  > {
    const db = await freshDb();
    const tracker = new MigrationTracker({ db });
    await tracker.initialize();
    const history = await tracker.getHistory({ limit: 100 });
    await db.close?.();
    return history.map((m: any) => ({ name: m.name, status: m.status }));
  }

  async function statusByName(): Promise<Record<string, string>> {
    return Object.fromEntries(
      (await readHistory()).map((m) => [m.name, m.status]),
    );
  }

  /** Ground truth for "did the schema actually change?". */
  async function tableExists(name: string): Promise<boolean> {
    const db = await freshDb();
    const result = await db.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      name,
    );
    await db.close?.();
    return result.rows.length > 0;
  }

  beforeEach(() => {
    process.exitCode = undefined;
    questionMock.mockClear();
    questionMock.mockResolvedValue('y');
    dbUrl = join(
      tmpdir(),
      `cov-rollback-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
    } as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    clearCache();
    try {
      rmSync(dbUrl, { force: true });
    } catch {
      // ignore
    }
  });

  function output(): string {
    return logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  }

  // JSON mode can emit multiple JSON documents; the meaningful payload is the
  // last one.
  function lastJson(): any {
    const jsonCalls = logSpy.mock.calls
      .map((call) => call.join(''))
      .filter((line) => line.trim().startsWith('{'));
    return JSON.parse(jsonCalls[jsonCalls.length - 1]);
  }

  function errorOutput(): string {
    return errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
  }

  it('errors out when the database is configured as :memory:', async () => {
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: ':memory:' } } },
    } as any);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as any);

    await dbRollbackCommand.handler([], {});

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorOutput()).toContain('Database configuration required');
    exitSpy.mockRestore();
  });

  it('emits a JSON error when the database is not configured (json mode)', async () => {
    clearCache();
    setConfig({ packages: { cli: { database: { url: '' } } } } as any);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined as never) as any);

    await dbRollbackCommand.handler([], { json: true });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(output()).toContain('Database not configured');
    exitSpy.mockRestore();
  });

  it('reports nothing to roll back when no migrations have been applied', async () => {
    await seedMigrations([]);

    await dbRollbackCommand.handler([], { force: true });

    expect(output()).toContain('No applied migrations to rollback');
  });

  it('reports nothing to roll back in JSON mode when history is empty', async () => {
    await seedMigrations([]);

    await dbRollbackCommand.handler([], { json: true, force: true });

    const parsed = JSON.parse(output());
    expect(parsed.message).toBe('No migrations to rollback');
  });

  describe('honesty contract (#2378)', () => {
    it('refuses a migration with no DOWN script instead of marking it rolled back', async () => {
      await seedMigrations([
        nonReversibleDef('m_one'),
        nonReversibleDef('m_two'),
      ]);

      await dbRollbackCommand.handler([], { force: true });

      expect(process.exitCode).toBe(1);
      expect(errorOutput()).toContain('Refusing to roll back');
      expect(errorOutput()).toContain('m_two');
      expect(errorOutput()).toContain('--mark-only');
      // The row is untouched and so is the schema — the two must agree.
      const byName = await statusByName();
      expect(byName.m_two).toBe('completed');
      expect(byName.m_one).toBe('completed');
      expect(await tableExists('m_two')).toBe(true);
    });

    it('emits a JSON refusal naming every unrecoverable migration', async () => {
      await seedMigrations([nonReversibleDef('jn_one')]);

      await dbRollbackCommand.handler([], { json: true, force: true });

      const parsed = lastJson();
      expect(process.exitCode).toBe(1);
      expect(parsed.error).toContain('Refusing to roll back');
      expect(parsed.unrecoverable).toEqual([
        { name: 'jn_one', reason: 'was applied without a DOWN script' },
      ]);
      // Back-compat: the pre-#2378 payload listed plain names under this key.
      expect(parsed.nonReversible).toEqual(['jn_one']);
      expect(parsed.guidance.join(' ')).toContain('--mark-only');
      expect((await statusByName()).jn_one).toBe('completed');
    });

    it('executes the recorded DOWN script of a create_table migration', async () => {
      await seedMigrations([createTableDef('r_one')]);
      expect(await tableExists('r_one')).toBe(true);

      await dbRollbackCommand.handler([], { force: true });

      expect(process.exitCode).toBeUndefined();
      // The schema — not just the tracking row — actually moved.
      expect(await tableExists('r_one')).toBe(false);
      expect((await statusByName()).create_table_r_one).toBe('rolled_back');
      expect(output()).toContain('Successfully rolled back 1 migration');
    });

    it('refuses a reversible migration whose DOWN SQL was never persisted', async () => {
      await seedMigrations([customReversibleDef('custom_one', 'custom_tbl')]);

      await dbRollbackCommand.handler([], { json: true, force: true });

      const parsed = lastJson();
      expect(process.exitCode).toBe(1);
      expect(parsed.unrecoverable[0].name).toBe('custom_one');
      expect(parsed.unrecoverable[0].reason).toContain(
        'cannot be reconstructed',
      );
      // A row the tracking table calls reversible still lands in the
      // compat key, because this run cannot reverse it either.
      expect(parsed.nonReversible).toEqual(['custom_one']);
      expect(await tableExists('custom_tbl')).toBe(true);
    });

    it('refuses the whole batch when only some migrations have a DOWN script', async () => {
      // Newest first: the create_table row is rollback-able, the older one is
      // not. Rolling back only the reversible half would leave the chain in a
      // state no DOWN script was written against, so nothing runs.
      await seedMigrations([
        nonReversibleDef('mixed_old'),
        createTableDef('mixed_new'),
      ]);

      await dbRollbackCommand.handler([], { steps: 2, force: true });

      expect(process.exitCode).toBe(1);
      const byName = await statusByName();
      expect(byName.create_table_mixed_new).toBe('completed');
      expect(byName.mixed_old).toBe('completed');
      expect(await tableExists('mixed_new')).toBe(true);
      expect(await tableExists('mixed_old')).toBe(true);
    });

    it('marks rows rolled back without touching the schema under --mark-only', async () => {
      await seedMigrations([nonReversibleDef('mo_one')]);

      await dbRollbackCommand.handler([], { force: true, markOnly: true });

      expect(process.exitCode).toBeUndefined();
      expect((await statusByName()).mo_one).toBe('rolled_back');
      // Explicitly opted into: the row moved, the schema did not, and the
      // output says so.
      expect(await tableExists('mo_one')).toBe(true);
      expect(output()).toContain('schema was NOT changed');
    });

    it('reports --mark-only in the JSON summary', async () => {
      await seedMigrations([nonReversibleDef('mj_one')]);

      await dbRollbackCommand.handler([], {
        force: true,
        json: true,
        markOnly: true,
      });

      const parsed = lastJson();
      expect(parsed.success).toBe(true);
      expect(parsed.markOnly).toBe(true);
      expect(parsed.results[0]).toMatchObject({
        name: 'mj_one',
        success: true,
        markedOnly: true,
      });
    });

    it('stops after a failed DOWN and reports the rest as not attempted', async () => {
      // A real SQLite fault, no mocking: `DROP TABLE IF EXISTS` refuses to
      // drop a view ("use DROP VIEW to delete view"), so the reconstructed
      // DOWN of `create_table_v_bad` genuinely fails.
      await seedMigrations([
        createTableDef('keep_me'),
        {
          id: 'create_table_v_bad',
          description: 'Create view v_bad',
          version: '1.0.0',
          up: ['CREATE VIEW v_bad AS SELECT 1 AS id'],
          down: ['DROP TABLE IF EXISTS "v_bad"'],
        },
      ]);

      await dbRollbackCommand.handler([], {
        steps: 2,
        force: true,
        json: true,
      });

      const parsed = lastJson();
      expect(process.exitCode).toBe(1);
      expect(parsed.success).toBe(false);
      expect(parsed.errorCount).toBe(2);
      expect(parsed.results[0]).toMatchObject({
        name: 'create_table_v_bad',
        success: false,
      });
      expect(parsed.results[1].error).toContain('Not attempted');
      // The migration behind the failure was never touched.
      const byName = await statusByName();
      expect(byName.create_table_keep_me).toBe('completed');
      expect(await tableExists('keep_me')).toBe(true);
    });

    it('prints a stack trace for rollback failures in verbose mode', async () => {
      await seedMigrations([
        {
          id: 'create_table_v_verbose',
          description: 'Create view v_verbose',
          version: '1.0.0',
          up: ['CREATE VIEW v_verbose AS SELECT 1 AS id'],
          down: ['DROP TABLE IF EXISTS "v_verbose"'],
        },
      ]);

      await dbRollbackCommand.handler([], { force: true, verbose: true });

      expect(errorOutput()).toContain('failed');
      expect(process.exitCode).toBe(1);
    });
  });

  it('rolls back N migrations when --steps is provided', async () => {
    await seedMigrations([
      createTableDef('s_one'),
      createTableDef('s_two'),
      createTableDef('s_three'),
    ]);

    await dbRollbackCommand.handler([], { steps: 2, force: true });

    const byName = await statusByName();
    expect(byName.create_table_s_three).toBe('rolled_back');
    expect(byName.create_table_s_two).toBe('rolled_back');
    expect(byName.create_table_s_one).toBe('completed');
    expect(await tableExists('s_three')).toBe(false);
    expect(await tableExists('s_two')).toBe(false);
    expect(await tableExists('s_one')).toBe(true);
  });

  it('rolls back everything after a target migration with --to (exclusive)', async () => {
    await seedMigrations([
      createTableDef('t_one'),
      createTableDef('t_two'),
      createTableDef('t_three'),
    ]);

    await dbRollbackCommand.handler([], {
      to: 'create_table_t_one',
      force: true,
    });

    const byName = await statusByName();
    expect(byName.create_table_t_three).toBe('rolled_back');
    expect(byName.create_table_t_two).toBe('rolled_back');
    expect(byName.create_table_t_one).toBe('completed');
    expect(await tableExists('t_one')).toBe(true);
  });

  it('lists the DOWN statements it is about to run', async () => {
    await seedMigrations([createTableDef('p_list')]);

    await dbRollbackCommand.handler([], { force: true });

    expect(output()).toContain('DROP TABLE IF EXISTS "p_list"');
  });

  it('errors when --to references an unknown migration', async () => {
    await seedMigrations([createTableDef('only_one')]);

    await dbRollbackCommand.handler([], { to: 'does_not_exist', force: true });

    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toContain('not found in history');
  });

  it('returns a JSON error when --to references an unknown migration', async () => {
    await seedMigrations([createTableDef('only_one')]);

    await dbRollbackCommand.handler([], {
      to: 'does_not_exist',
      json: true,
      force: true,
    });

    expect(process.exitCode).toBe(1);
    expect(output()).toContain('not found');
  });

  it('reports nothing to rollback when --to targets the latest migration', async () => {
    await seedMigrations([
      createTableDef('top_one'),
      createTableDef('top_two'),
    ]);

    // The latest applied migration is at index 0; nothing comes after it.
    await dbRollbackCommand.handler([], {
      to: 'create_table_top_two',
      force: true,
    });

    expect(output()).toContain('Nothing to rollback');
  });

  it('previews a rollback without mutating history or schema in --dry-run mode', async () => {
    await seedMigrations([createTableDef('d_one'), createTableDef('d_two')]);

    await dbRollbackCommand.handler([], { dryRun: true, force: true });

    expect(output()).toContain('Dry-run');
    const history = await readHistory();
    expect(history.every((m) => m.status === 'completed')).toBe(true);
    expect(await tableExists('d_two')).toBe(true);
  });

  it('emits structured dry-run output in JSON mode', async () => {
    await seedMigrations([createTableDef('dj_one')]);

    await dbRollbackCommand.handler([], {
      dryRun: true,
      json: true,
      force: true,
    });

    const parsed = lastJson();
    expect(parsed.dryRun).toBe(true);
    expect(parsed.migrationsToRollback[0].name).toBe('create_table_dj_one');
    expect(parsed.migrationsToRollback[0].down).toEqual([
      'DROP TABLE IF EXISTS "dj_one"',
    ]);
  });

  it('refuses (non-zero) in --dry-run when the real run would refuse', async () => {
    await seedMigrations([nonReversibleDef('dn_one')]);

    await dbRollbackCommand.handler([], { dryRun: true, force: true });

    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toContain('Refusing to roll back');
    const history = await readHistory();
    expect(history.every((m) => m.status === 'completed')).toBe(true);
  });

  it('marks an unrecoverable migration with ⊘ in --dry-run --mark-only output', async () => {
    // The only preview that lists an unrecoverable row: without --mark-only the
    // run refuses before reaching the dry-run listing.
    await seedMigrations([nonReversibleDef('dm_one')]);

    await dbRollbackCommand.handler([], {
      dryRun: true,
      markOnly: true,
      force: true,
    });

    expect(output()).toContain('⊘ dm_one (no DOWN script)');
    expect(output()).not.toContain('↩ dm_one');
    const history = await readHistory();
    expect(history.every((m) => m.status === 'completed')).toBe(true);
  });

  it('emits a JSON summary of a successful rollback', async () => {
    await seedMigrations([createTableDef('jr_one'), createTableDef('jr_two')]);

    await dbRollbackCommand.handler([], { json: true, force: true });

    const parsed = lastJson();
    expect(parsed.success).toBe(true);
    expect(parsed.successCount).toBe(1);
    expect(parsed.errorCount).toBe(0);
    expect(parsed.results[0].name).toBe('create_table_jr_two');
    expect(parsed.results[0].statements).toEqual([
      'DROP TABLE IF EXISTS "jr_two"',
    ]);
  });

  it('cancels the rollback when the interactive prompt is declined', async () => {
    await seedMigrations([createTableDef('c_one')]);
    questionMock.mockResolvedValue('n');

    await dbRollbackCommand.handler([], {});

    expect(output()).toContain('Cancelled by user');
    expect((await statusByName()).create_table_c_one).toBe('completed');
    expect(await tableExists('c_one')).toBe(true);
  });

  it('proceeds with the rollback when the interactive prompt is confirmed', async () => {
    await seedMigrations([createTableDef('p_one')]);
    questionMock.mockResolvedValue('yes');

    await dbRollbackCommand.handler([], {});

    expect((await statusByName()).create_table_p_one).toBe('rolled_back');
    expect(await tableExists('p_one')).toBe(false);
    expect(questionMock).toHaveBeenCalled();
  });

  /**
   * Regression for the data-loss BLOCKER (#1385): the `'dry-run'` option is
   * declared kebab-cased, and `parseCliArgs` returns keys verbatim, so the real
   * CLI produces `options['dry-run']`. The handler previously read
   * `options.dryRun` (always undefined on the CLI path), so `--dry-run` fell
   * through and executed real rollbacks. The handler-direct tests above passed a
   * `{ dryRun: true }` key the real CLI never produces, masking the hole — these
   * tests route through `parseCliArgs` like the actual command dispatcher.
   * `--mark-only` is declared the same way and is covered here for the same
   * reason.
   */
  describe('kebab option keys via parseCliArgs (regression #1385)', () => {
    function route(argv: string[]) {
      const parsed = parseCliArgs(
        ['db:rollback', ...argv],
        [dbRollbackCommand as any],
        {},
      );
      return dbRollbackCommand.handler(parsed.args, parsed.options);
    }

    it('produces the kebab option keys, not camelCase ones', () => {
      const parsed = parseCliArgs(
        ['db:rollback', '--dry-run', '--mark-only', '--force'],
        [dbRollbackCommand as any],
        {},
      );
      // Proves the premise: the real CLI never yields `dryRun`/`markOnly`.
      expect(parsed.options['dry-run']).toBe(true);
      expect(parsed.options['mark-only']).toBe(true);
      expect((parsed.options as any).dryRun).toBeUndefined();
      expect((parsed.options as any).markOnly).toBeUndefined();
    });

    it('does NOT execute any rollback when --dry-run is passed (data-loss guard)', async () => {
      await seedMigrations([
        createTableDef('dry_one'),
        createTableDef('dry_two'),
      ]);

      const rollbackSpy = vi.spyOn(MigrationTracker.prototype, 'rollback');

      await route(['--dry-run', '--force']);

      expect(rollbackSpy).not.toHaveBeenCalled();
      expect(output()).toContain('Dry-run');

      // Real DB state is the ground truth: nothing was rolled back or dropped.
      const history = await readHistory();
      expect(history.every((m) => m.status === 'completed')).toBe(true);
      expect(await tableExists('dry_two')).toBe(true);

      rollbackSpy.mockRestore();
    });

    it('emits structured dry-run JSON without mutating history via the CLI path', async () => {
      await seedMigrations([createTableDef('dry_json')]);

      await route(['--dry-run', '--json', '--force']);

      const parsed = lastJson();
      expect(parsed.dryRun).toBe(true);
      const history = await readHistory();
      expect(history.every((m) => m.status === 'completed')).toBe(true);
    });

    it('still executes the rollback when --dry-run is absent (CLI path)', async () => {
      await seedMigrations([createTableDef('wet_one')]);

      await route(['--force']);

      expect((await statusByName()).create_table_wet_one).toBe('rolled_back');
      expect(await tableExists('wet_one')).toBe(false);
    });

    it('honours --mark-only from the CLI path', async () => {
      await seedMigrations([nonReversibleDef('cli_mark')]);

      await route(['--mark-only', '--force']);

      expect((await statusByName()).cli_mark).toBe('rolled_back');
      expect(await tableExists('cli_mark')).toBe(true);
      expect(output()).toContain('schema was NOT changed');
    });

    it('refuses from the CLI path when --mark-only is absent', async () => {
      await seedMigrations([nonReversibleDef('cli_refuse')]);

      await route(['--force']);

      expect(process.exitCode).toBe(1);
      expect((await statusByName()).cli_refuse).toBe('completed');
    });
  });
});

describe('recoverDownStatements', () => {
  it('reconstructs the DOWN of a create_table migration', () => {
    expect(
      recoverDownStatements({
        name: 'create_table_users',
        is_reversible: true,
      }),
    ).toEqual({
      recoverable: true,
      statements: ['DROP TABLE IF EXISTS "users"'],
    });
  });

  it('refuses a create_table row that was not recorded reversible', () => {
    const recovery = recoverDownStatements({
      name: 'create_table_users',
      is_reversible: false,
    });
    expect(recovery.recoverable).toBe(false);
    expect(recovery).toMatchObject({
      reason: expect.stringContaining('not reversible'),
    });
  });

  it('refuses a reversible migration whose SQL is not stored', () => {
    const recovery = recoverDownStatements({
      name: 'add_column_users_email',
      is_reversible: true,
    });
    expect(recovery.recoverable).toBe(false);
    expect(recovery).toMatchObject({
      reason: expect.stringContaining('cannot be reconstructed'),
    });
  });

  it('refuses an auto-migration applied without a DOWN', () => {
    const recovery = recoverDownStatements({
      name: 'add_index_users_email',
      is_reversible: false,
    });
    expect(recovery.recoverable).toBe(false);
    expect(recovery).toMatchObject({
      reason: 'was applied without a DOWN script',
    });
  });

  it('refuses a create_table row whose table name is not a plain identifier', () => {
    const recovery = recoverDownStatements({
      name: 'create_table_users"; DROP TABLE secrets; --',
      is_reversible: true,
    });
    expect(recovery.recoverable).toBe(false);
    expect(recovery).toMatchObject({
      reason: expect.stringContaining('not a plain identifier'),
    });
  });

  /**
   * Coupling guard: the reconstruction above is only valid while `db:migrate`
   * keeps recording that exact DOWN for `diff.added_tables`. If this assertion
   * fails, update `recoverDownStatements` in `db-rollback.ts` alongside it.
   */
  it('matches the DOWN script db:migrate records for added tables', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../utilities.ts', import.meta.url)),
      'utf8',
    );
    // Regexes (not string literals) so the `${…}` we are matching against is
    // not itself flagged as an unintended template placeholder.
    expect(source).toMatch(/DROP TABLE IF EXISTS "\$\{schema\.tableName\}"/);
    expect(source).toMatch(/`create_table_\$\{schema\.tableName\}`/);
  });
});
