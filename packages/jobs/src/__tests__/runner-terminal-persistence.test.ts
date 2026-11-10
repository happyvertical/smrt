/**
 * #4735: a terminal write that cannot be persisted must never be silent.
 *
 * Preparing the terminal-outcome storage builds the registry's merged schemas,
 * so two unrelated classes claiming one table used to make every terminal
 * write throw. The runner emitted `runner:error`, logged nothing, and left
 * every claimed job `running`.
 *
 * Real in-memory SQLite and the real runner. Only the merged schema build is
 * made to throw, the way a registry inconsistency makes it throw.
 */
import {
  ConfigurationError,
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backgroundEligible } from '../background-policy.js';
import { createTaskRunner } from '../runner.js';
import { type SmrtJob, SmrtJobCollection } from '../smrt-job.js';
import { SmrtJobEventCollection } from '../smrt-job-event.js';

let releaseGate: (() => void) | null = null;

@smrt()
class TerminalPersistenceProbe extends SmrtObject {
  @backgroundEligible()
  async succeeds(): Promise<string> {
    return 'ok';
  }

  // Holds the handler open so the test can change the registry mid-job.
  @backgroundEligible()
  async succeedsWhenReleased(): Promise<string> {
    await new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    return 'ok';
  }
}

const claimMessage =
  "Table 'accounts' is claimed by unrelated classes A and B. Classes share a table only as one single-table-inheritance family";

function breakMergedSchemas() {
  return vi
    .spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions')
    .mockImplementation(() => {
      throw new ConfigurationError(claimMessage, 'CONFIG_TABLE_NAME_COLLISION');
    });
}

function probeType(): string {
  return (
    ObjectRegistry.getClass('TerminalPersistenceProbe')?.qualifiedName ??
    'TerminalPersistenceProbe'
  );
}

async function setup(method: string) {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  const collection = await SmrtJobCollection.create({ db });
  const job = await collection.create({
    objectType: probeType(),
    method,
    args: {},
    maxAttempts: 1,
  });
  await job.save();
  const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
  await runner.initialize(db);
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    errors.push(parts.map(String).join(' '));
  });
  return { db, collection, job, runner, errors };
}

function once<T>(
  runner: ReturnType<typeof createTaskRunner>,
  event: 'job:completed' | 'job:failed' | 'runner:error',
): Promise<T> {
  return new Promise<T>((resolve) => {
    runner.once(event, (payload: unknown) => resolve(payload as T));
  });
}

afterEach(() => {
  releaseGate = null;
  vi.restoreAllMocks();
});

describe('TaskRunner terminal persistence (#4735)', () => {
  it('refuses to start, saying why, when terminal outcomes cannot be persisted', async () => {
    const { collection, job, runner, errors } = await setup('succeeds');
    const broken = breakMergedSchemas();

    await expect(runner.start()).rejects.toThrow(claimMessage);
    expect(
      errors.some(
        (line) =>
          line.includes('TaskRunner cannot start') &&
          line.includes("Table 'accounts' is claimed by unrelated classes"),
      ),
    ).toBe(true);
    // Nothing was claimed: the job is still waiting, not stranded as running.
    expect((await collection.get({ id: job.id ?? '' }))?.status).toBe(
      'pending',
    );

    // The refusal is not sticky: once the registry is consistent the same
    // runner starts and the job completes.
    broken.mockRestore();
    const completed = once<SmrtJob>(runner, 'job:completed');
    await runner.start();
    try {
      expect((await completed).id).toBe(job.id);
    } finally {
      await runner.stop();
    }
  });

  it('still completes a job when the registry becomes inconsistent after start', async () => {
    const { db, collection, job, runner } = await setup('succeedsWhenReleased');
    const completed = once<SmrtJob>(runner, 'job:completed');
    const runnerError = once<Error>(runner, 'runner:error');

    await runner.start();
    try {
      // The handler is running; a lazily imported model family now makes the
      // merged schema build throw, as in the consumer that reported #4735.
      await vi.waitFor(() => expect(releaseGate).not.toBeNull());
      breakMergedSchemas();
      releaseGate?.();

      const outcome = await Promise.race([
        completed.then(() => 'completed' as const),
        runnerError.then((error) => `runner:error ${error.message}`),
      ]);
      expect(outcome).toBe('completed');
      expect((await collection.get({ id: job.id ?? '' }))?.status).toBe(
        'completed',
      );
      // The state and its event still commit together.
      vi.restoreAllMocks();
      const events = await SmrtJobEventCollection.create({ db });
      const page = await events.listTerminalOutcomes({ tenantId: null });
      expect(
        page.outcomes
          .filter((entry) => entry.jobId === job.id)
          .map((entry) => entry.status),
      ).toEqual(['completed']);
    } finally {
      releaseGate?.();
      await runner.stop();
    }
  });

  it('logs an orphan it cannot settle by id and recovers the others', async () => {
    const { db, collection, job, runner, errors } = await setup('succeeds');
    const other = await collection.create({
      objectType: probeType(),
      method: 'succeeds',
      args: {},
      maxAttempts: 1,
    });
    await other.save();
    // Both rows belong to a worker that is gone.
    await db.query(
      `UPDATE _smrt_jobs
          SET status = 'running', worker_id = 'worker-that-died', attempts = 1`,
    );
    await db.query(`CREATE TRIGGER reject_one_recovery_event
      BEFORE INSERT ON _smrt_job_events
      WHEN NEW.job_id = '${job.id}' AND NEW.stage = 'stale-recovery'
      BEGIN
        SELECT RAISE(FAIL, 'recovery event rejected');
      END`);
    const recovered = once<SmrtJob>(runner, 'job:failed');
    const runnerError = once<Error>(runner, 'runner:error');

    await runner.start();
    try {
      expect((await recovered).id).toBe(other.id);
      expect((await runnerError).message).toMatch(/recovery event rejected/);
      expect((await collection.get({ id: other.id ?? '' }))?.status).toBe(
        'failed',
      );
      // Neither half of the rejected transition committed.
      expect((await collection.get({ id: job.id ?? '' }))?.status).toBe(
        'running',
      );
      expect(
        errors.some(
          (line) =>
            line.includes(job.id ?? 'missing-id') &&
            line.includes('stale recovery could not be persisted'),
        ),
      ).toBe(true);
    } finally {
      await runner.stop();
    }
  });
});
