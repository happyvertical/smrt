import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../runner.js';
import { ScheduleRunner } from '../schedule-runner.js';

afterEach(() => vi.unstubAllEnvs());

describe('workers refuse unmigrated production starts (#4929)', () => {
  it.each([
    'task',
    'schedule',
  ] as const)('%s refuses before starting its loop', async (kind) => {
    const db = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
    const runner =
      kind === 'task'
        ? new TaskRunner({ retention: false })
        : new ScheduleRunner();
    try {
      // Construction and system bootstrap remain allowed; strict policy starts
      // only when starting the long-lived worker, before its polling loop.
      await runner.initialize(db);
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('SMRT_ALLOW_UNMIGRATED_START', '');
      await expect(runner.start()).rejects.toThrow('smrt db:migrate');
      await expect(runner.start()).rejects.toThrow('smrt db:migrate');
      expect(await db.tableExists('_smrt_migrate_runs')).toBe(true);
      const rows = await db.query('SELECT * FROM _smrt_migrate_runs');
      expect(rows.rows).toHaveLength(0);
    } finally {
      await runner.stop();
      await db.close?.();
    }
  });
});
