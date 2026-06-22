import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { MigrationTracker } from '@happyvertical/smrt-core/migrations';
import { getDatabase } from '@happyvertical/sql';
import { parseCliArgs } from '@happyvertical/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbRollbackCommand } from '../db-rollback.js';

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
 * assert how it mutated the `_smrt_schema_migrations` rows.
 *
 * Note on reversibility: the command builds a synthetic rollback definition with
 * an empty `down`, so a row recorded as reversible (a real `down` was present at
 * apply time) FAILS the tracker rollback, while a non-reversible row (applied
 * with an empty `down`) is force-marked `rolled_back`. The tests below seed each
 * kind deliberately to drive both branches.
 */
describe('db:rollback (real SQLite)', () => {
  let dbUrl: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  function reversibleDef(id: string) {
    return {
      id,
      description: `Migration ${id}`,
      version: '1.0.0',
      up: [`CREATE TABLE ${id} (id TEXT PRIMARY KEY)`],
      down: [`DROP TABLE ${id}`],
    };
  }

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
    defs: Array<ReturnType<typeof reversibleDef>>,
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

  // JSON mode can emit multiple JSON documents (e.g. a non-reversible warning
  // followed by the final summary); the meaningful payload is the last one.
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

  it('force-marks the most recent non-reversible migration rolled back by default', async () => {
    await seedMigrations([
      nonReversibleDef('m_one'),
      nonReversibleDef('m_two'),
      nonReversibleDef('m_three'),
    ]);

    await dbRollbackCommand.handler([], { force: true });

    const byName = Object.fromEntries(
      (await readHistory()).map((m) => [m.name, m.status]),
    );
    expect(byName.m_three).toBe('rolled_back');
    expect(byName.m_two).toBe('completed');
    expect(byName.m_one).toBe('completed');
    expect(output()).toContain('Successfully rolled back 1 migration');
  });

  it('rolls back N migrations when --steps is provided', async () => {
    await seedMigrations([
      nonReversibleDef('s_one'),
      nonReversibleDef('s_two'),
      nonReversibleDef('s_three'),
    ]);

    await dbRollbackCommand.handler([], { steps: 2, force: true });

    const byName = Object.fromEntries(
      (await readHistory()).map((m) => [m.name, m.status]),
    );
    expect(byName.s_three).toBe('rolled_back');
    expect(byName.s_two).toBe('rolled_back');
    expect(byName.s_one).toBe('completed');
  });

  it('rolls back everything after a target migration with --to (exclusive)', async () => {
    await seedMigrations([
      nonReversibleDef('t_one'),
      nonReversibleDef('t_two'),
      nonReversibleDef('t_three'),
    ]);

    await dbRollbackCommand.handler([], { to: 't_one', force: true });

    const byName = Object.fromEntries(
      (await readHistory()).map((m) => [m.name, m.status]),
    );
    expect(byName.t_three).toBe('rolled_back');
    expect(byName.t_two).toBe('rolled_back');
    expect(byName.t_one).toBe('completed');
  });

  it('warns about non-reversible migrations in the rollback set', async () => {
    await seedMigrations([nonReversibleDef('w_one')]);

    await dbRollbackCommand.handler([], { force: true });

    expect(output()).toContain('not reversible');
  });

  it('reports a JSON error when some migrations are not reversible', async () => {
    await seedMigrations([nonReversibleDef('jn_one')]);

    await dbRollbackCommand.handler([], { json: true, force: true });

    const lines = logSpy.mock.calls.map((call) => call.join(' '));
    const nonReversibleLine = lines.find((line) =>
      line.includes('not reversible'),
    );
    expect(nonReversibleLine).toBeDefined();
  });

  it('records a failed result when a reversible migration cannot run its (empty) DOWN script', async () => {
    // A reversible row drives the tracker.rollback path; the synthetic
    // definition the command builds has an empty `down`, so the tracker reports
    // the migration as not reversible and the command counts it as an error.
    await seedMigrations([reversibleDef('rev_one')]);

    await dbRollbackCommand.handler([], { json: true, force: true });

    const parsed = lastJson();
    expect(parsed.success).toBe(false);
    expect(parsed.errorCount).toBe(1);
    expect(parsed.results[0].success).toBe(false);
  });

  it('prints a stack trace for reversible rollback failures in verbose mode', async () => {
    await seedMigrations([reversibleDef('rev_v')]);

    await dbRollbackCommand.handler([], { force: true, verbose: true });

    expect(errorOutput()).toContain('failed');
  });

  it('errors when --to references an unknown migration', async () => {
    await seedMigrations([nonReversibleDef('only_one')]);

    await dbRollbackCommand.handler([], { to: 'does_not_exist', force: true });

    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toContain('not found in history');
  });

  it('returns a JSON error when --to references an unknown migration', async () => {
    await seedMigrations([nonReversibleDef('only_one')]);

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
      nonReversibleDef('top_one'),
      nonReversibleDef('top_two'),
    ]);

    // The latest applied migration is at index 0; nothing comes after it.
    await dbRollbackCommand.handler([], { to: 'top_two', force: true });

    expect(output()).toContain('Nothing to rollback');
  });

  it('previews a rollback without mutating history in --dry-run mode', async () => {
    await seedMigrations([
      nonReversibleDef('d_one'),
      nonReversibleDef('d_two'),
    ]);

    await dbRollbackCommand.handler([], { dryRun: true, force: true });

    expect(output()).toContain('Dry-run');
    const history = await readHistory();
    expect(history.every((m) => m.status === 'completed')).toBe(true);
  });

  it('emits structured dry-run output in JSON mode', async () => {
    await seedMigrations([nonReversibleDef('dj_one')]);

    await dbRollbackCommand.handler([], {
      dryRun: true,
      json: true,
      force: true,
    });

    const parsed = lastJson();
    expect(parsed.dryRun).toBe(true);
    expect(parsed.migrationsToRollback[0].name).toBe('dj_one');
  });

  it('emits a JSON summary of a successful rollback', async () => {
    await seedMigrations([
      nonReversibleDef('jr_one'),
      nonReversibleDef('jr_two'),
    ]);

    await dbRollbackCommand.handler([], { json: true, force: true });

    const parsed = lastJson();
    expect(parsed.success).toBe(true);
    expect(parsed.successCount).toBe(1);
    expect(parsed.errorCount).toBe(0);
    expect(parsed.results[0].name).toBe('jr_two');
  });

  it('cancels the rollback when the interactive prompt is declined', async () => {
    await seedMigrations([nonReversibleDef('c_one')]);
    questionMock.mockResolvedValue('n');

    await dbRollbackCommand.handler([], {});

    expect(output()).toContain('Cancelled by user');
    const history = await readHistory();
    expect(history[0].status).toBe('completed');
  });

  it('proceeds with the rollback when the interactive prompt is confirmed', async () => {
    await seedMigrations([nonReversibleDef('p_one')]);
    questionMock.mockResolvedValue('yes');

    await dbRollbackCommand.handler([], {});

    const history = await readHistory();
    expect(history[0].status).toBe('rolled_back');
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
   */
  describe('--dry-run via parseCliArgs (regression #1385)', () => {
    function route(argv: string[]) {
      const parsed = parseCliArgs(
        ['db:rollback', ...argv],
        [dbRollbackCommand as any],
        {},
      );
      return dbRollbackCommand.handler(parsed.args, parsed.options);
    }

    it('produces the kebab option key, not a camelCase one', () => {
      const parsed = parseCliArgs(
        ['db:rollback', '--dry-run', '--force'],
        [dbRollbackCommand as any],
        {},
      );
      // Proves the premise: the real CLI never yields `dryRun`.
      expect(parsed.options['dry-run']).toBe(true);
      expect((parsed.options as any).dryRun).toBeUndefined();
    });

    it('does NOT execute any rollback when --dry-run is passed (data-loss guard)', async () => {
      await seedMigrations([
        nonReversibleDef('dry_one'),
        nonReversibleDef('dry_two'),
      ]);

      // Stub the destructive boundaries: the reversible path goes through
      // MigrationTracker.rollback; the non-reversible path issues a raw UPDATE
      // via db.query. Neither must fire under --dry-run.
      const rollbackSpy = vi.spyOn(MigrationTracker.prototype, 'rollback');

      await route(['--dry-run', '--force']);

      expect(rollbackSpy).not.toHaveBeenCalled();
      expect(output()).toContain('Dry-run');

      // Real DB state is the ground truth: nothing was marked rolled_back.
      const history = await readHistory();
      expect(history.every((m) => m.status === 'completed')).toBe(true);

      rollbackSpy.mockRestore();
    });

    it('emits structured dry-run JSON without mutating history via the CLI path', async () => {
      await seedMigrations([nonReversibleDef('dry_json')]);

      await route(['--dry-run', '--json', '--force']);

      const parsed = lastJson();
      expect(parsed.dryRun).toBe(true);
      const history = await readHistory();
      expect(history.every((m) => m.status === 'completed')).toBe(true);
    });

    it('still executes the rollback when --dry-run is absent (CLI path)', async () => {
      await seedMigrations([nonReversibleDef('wet_one')]);

      await route(['--force']);

      const history = await readHistory();
      expect(history[0].status).toBe('rolled_back');
    });
  });
});
