import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DeploymentPhaseTracker,
  type DeploymentReconciledContext,
  type DeploymentStepOptions,
  type DeploymentStepTransaction,
  MAX_DEPLOYMENT_CHECKPOINT_BYTES,
} from '../deployment-phase-tracker.js';

const url = process.env.SMRT_TEST_POSTGRES_URL ?? process.env.DATABASE_URL;
describe.skipIf(!url)('durable deployment phases (real PostgreSQL)', () => {
  let first: DatabaseInterface;
  let second: DatabaseInterface;
  let tracker: DeploymentPhaseTracker;
  const application = `deployment-test-${randomUUID()}`;
  const options = (stepId: string): DeploymentStepOptions => ({
    application,
    environment: 'test',
    stepId,
    checksum: 'sha256:stable',
    checkSafety: async () => {},
  });
  beforeAll(async () => {
    first = await getDatabase({
      type: 'postgres',
      url: url as string,
      dbid: randomUUID(),
    });
    second = await getDatabase({
      type: 'postgres',
      url: url as string,
      dbid: randomUUID(),
    });
    tracker = new DeploymentPhaseTracker(first);
    await first.query(
      'CREATE TABLE IF NOT EXISTS _smrt_deployment_test_values (id TEXT PRIMARY KEY, value BIGINT NOT NULL)',
    );
  });
  afterAll(async () => {
    await first?.query(
      'DELETE FROM _smrt_deployment_test_values WHERE id LIKE ?',
      `${application}%`,
    );
    await first?.query(
      'DELETE FROM _smrt_deployment_steps WHERE application = ?',
      application,
    );
    await first?.close?.();
    await second?.close?.();
  });
  it('refuses failed preflight before provisioning or running any work', async () => {
    const work = vi.fn();
    await expect(
      tracker.runTransactionalStep(
        {
          ...options('unsafe'),
          checkSafety: async () => {
            throw new Error('writers active');
          },
        },
        work,
      ),
    ).rejects.toThrow('writers active');
    expect(work).not.toHaveBeenCalled();
    expect(await tracker.getStepStatus(options('unsafe'))).toBeNull();
  });
  it('commits data and marker atomically and never replays a prior committed step after a later failure', async () => {
    const one = options('committed');
    const id = `${application}-committed`;
    const work = vi.fn(async (tx: DeploymentStepTransaction) => {
      await tx.query(
        'INSERT INTO _smrt_deployment_test_values VALUES (?, 1)',
        id,
      );
    });
    await tracker.runTransactionalStep(one, work);
    await expect(
      tracker.runTransactionalStep(options('later-failure'), async (tx) => {
        await tx.query(
          'UPDATE _smrt_deployment_test_values SET value = 2 WHERE id = ?',
          id,
        );
        throw new Error('later failed');
      }),
    ).rejects.toThrow('later failed');
    expect(await tracker.getStepStatus(options('later-failure'))).toBeNull();
    await tracker.runTransactionalStep(one, work);
    expect(work).toHaveBeenCalledTimes(1);
    expect(
      Number(
        (
          await second.query(
            'SELECT value FROM _smrt_deployment_test_values WHERE id = ?',
            id,
          )
        ).rows[0].value,
      ),
    ).toBe(1);
    expect((await tracker.getStepStatus(one))?.status).toBe('complete');
  });
  it('serializes separate pools and executes one transaction for concurrent callers', async () => {
    const step = options('concurrent');
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = vi.fn(async () => {
      entered();
      await gate;
    });
    const holder = tracker.runTransactionalStep(step, work);
    await enteredPromise;
    const contender = new DeploymentPhaseTracker(second).runTransactionalStep(
      { ...step, lockTimeoutMs: 100 },
      work,
    );
    await expect(contender).rejects.toThrow();
    release();
    await holder;
    await new DeploymentPhaseTracker(second).runTransactionalStep(step, work);
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('rejects changed checksums and modes before callbacks execute', async () => {
    const work = vi.fn(async () => {});
    await tracker.runTransactionalStep(options('immutable'), work);
    work.mockClear();
    await expect(
      tracker.runTransactionalStep(
        { ...options('immutable'), checksum: 'changed' },
        work,
      ),
    ).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    await expect(
      tracker.runReconciledStep({
        ...options('immutable'),
        inspect: async () => {
          work();
          return { outcome: 'complete' };
        },
        apply: work,
      }),
    ).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    expect(work).not.toHaveBeenCalled();
  });
  it('recovers an ambiguous effect without replay after the session dies before marking complete', async () => {
    const step = options('interrupted');
    const id = `${application}-interrupted`;
    let applyCalls = 0;
    await expect(
      tracker.runReconciledStep({
        ...step,
        inspect: async (context) => ({
          outcome: (
            await context.query(
              'SELECT id FROM _smrt_deployment_test_values WHERE id = ?',
              id,
            )
          ).rows.length
            ? 'complete'
            : 'safe-to-resume',
        }),
        apply: async (context) => {
          applyCalls++;
          const backend = await context.query('SELECT pg_backend_pid() AS pid');
          // Represents an external durable effect, committed on another connection.
          await second.query(
            'INSERT INTO _smrt_deployment_test_values VALUES (?, 1)',
            id,
          );
          await second.query(
            'SELECT pg_terminate_backend(?)',
            backend.rows[0].pid,
          );
          await context.assertActive();
        },
      }),
    ).rejects.toThrow();
    expect((await tracker.getStepStatus(step))?.status).toBe('running');
    await new DeploymentPhaseTracker(second).runReconciledStep({
      ...step,
      inspect: async (context) => ({
        outcome: (
          await context.query(
            'SELECT id FROM _smrt_deployment_test_values WHERE id = ?',
            id,
          )
        ).rows.length
          ? 'complete'
          : 'needs-repair',
      }),
      apply: async () => {
        applyCalls++;
      },
    });
    expect(applyCalls).toBe(1);
    expect((await tracker.getStepStatus(step))?.status).toBe('complete');
  });
  it('refuses unknown partial outcomes, then resumes only after inspection proves safety', async () => {
    const step = options('partial');
    let state = 'partial';
    const apply = vi.fn(async (context: DeploymentReconciledContext) => {
      await context.saveCheckpoint({ cursor: 2 });
      state = 'done';
    });
    await expect(
      tracker.runReconciledStep({
        ...step,
        inspect: async () => ({ outcome: 'needs-repair' }),
        apply,
      }),
    ).rejects.toMatchObject({ code: 'NEEDS_REPAIR' });
    expect(apply).not.toHaveBeenCalled();
    expect((await tracker.getStepStatus(step))?.status).toBe('needs-repair');
    await tracker.runReconciledStep({
      ...step,
      inspect: async () => ({
        outcome: state === 'done' ? 'complete' : 'safe-to-resume',
      }),
      apply,
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect((await tracker.getStepStatus(step))?.checkpoint).toEqual({
      cursor: 2,
    });
  });
  it.each([
    'needs-repair',
    'safe-to-resume',
  ] as const)('retains the post-apply %s checkpoint for the next reconciliation', async (outcome) => {
    const step = options(`post-apply-${outcome}`);
    let inspections = 0;
    const apply = vi.fn(async () => {});
    await expect(
      tracker.runReconciledStep({
        ...step,
        inspect: async () => {
          inspections++;
          return inspections === 1
            ? { outcome: 'safe-to-resume', checkpoint: { cursor: 0 } }
            : {
                outcome,
                checkpoint: { cursor: 10, operationId: 'external-1' },
              };
        },
        apply,
      }),
    ).rejects.toMatchObject({ code: 'NEEDS_REPAIR' });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(await tracker.getStepStatus(step)).toMatchObject({
      status: 'needs-repair',
      checkpoint: { cursor: 10, operationId: 'external-1' },
    });
    await new DeploymentPhaseTracker(second).runReconciledStep({
      ...step,
      inspect: async (context) => {
        expect(context.checkpoint).toEqual({
          cursor: 10,
          operationId: 'external-1',
        });
        return { outcome: 'complete' };
      },
      apply,
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(await tracker.getStepStatus(step)).toMatchObject({
      status: 'complete',
      checkpoint: { cursor: 10, operationId: 'external-1' },
    });
  });
  it('persists a checkpoint at the exact serialized UTF-8 byte limit', async () => {
    const step = options('checkpoint-limit');
    const checkpoint = 'x'.repeat(MAX_DEPLOYMENT_CHECKPOINT_BYTES - 2);
    await tracker.runReconciledStep({
      ...step,
      inspect: async () => ({ outcome: 'complete', checkpoint }),
      apply: async () => {
        throw new Error('complete inspection must skip apply');
      },
    });
    expect((await tracker.getStepStatus(step))?.checkpoint).toBe(checkpoint);
  });
  it.each([
    ['oversized-utf8', () => 'é'.repeat(MAX_DEPLOYMENT_CHECKPOINT_BYTES / 2)],
    [
      'circular',
      () => {
        const value: { self?: unknown } = {};
        value.self = value;
        return value;
      },
    ],
    ['bigint', () => 1n],
  ])('preserves a prior checkpoint and reconciles effects after rejecting %s', async (name, invalidCheckpoint) => {
    const step = options(`checkpoint-${name}`);
    const id = `${application}-checkpoint-${name}`;
    const retained = { cursor: 1 };
    const apply = vi.fn(async (context: DeploymentReconciledContext) => {
      await context.saveCheckpoint(retained);
      await second.query(
        'INSERT INTO _smrt_deployment_test_values VALUES (?, 1)',
        id,
      );
      await context.saveCheckpoint(invalidCheckpoint());
    });
    const inspect = async (context: DeploymentReconciledContext) => ({
      outcome: (
        await context.query(
          'SELECT id FROM _smrt_deployment_test_values WHERE id = ?',
          id,
        )
      ).rows.length
        ? ('complete' as const)
        : ('safe-to-resume' as const),
    });
    await expect(
      tracker.runReconciledStep({ ...step, inspect, apply }),
    ).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' });
    expect((await tracker.getStepStatus(step))?.checkpoint).toEqual(retained);
    expect((await tracker.getStepStatus(step))?.status).toBe('needs-repair');
    await new DeploymentPhaseTracker(second).runReconciledStep({
      ...step,
      inspect,
      apply,
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect((await tracker.getStepStatus(step))?.checkpoint).toEqual(retained);
    expect((await tracker.getStepStatus(step))?.status).toBe('complete');
  });
  it('rolls back data when the pinned transaction connection is terminated', async () => {
    const step = options('killed-tx');
    const id = `${application}-killed-tx`;
    await expect(
      tracker.runTransactionalStep(step, async (tx) => {
        await tx.query(
          'INSERT INTO _smrt_deployment_test_values VALUES (?, 1)',
          id,
        );
        const pid = (await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]
          .pid;
        await second.query('SELECT pg_terminate_backend(?)', pid);
      }),
    ).rejects.toThrow();
    expect(await tracker.getStepStatus(step)).toBeNull();
    expect(
      (
        await second.query(
          'SELECT * FROM _smrt_deployment_test_values WHERE id = ?',
          id,
        )
      ).rows,
    ).toHaveLength(0);
    await tracker.runTransactionalStep(step, async (tx) => {
      await tx.query(
        'INSERT INTO _smrt_deployment_test_values VALUES (?, 1)',
        id,
      );
    });
    expect((await tracker.getStepStatus(step))?.status).toBe('complete');
  });
  it.each([
    'before-send',
    'after-commit',
  ] as const)('recovers an interrupted COMMIT %s without a marker/data gap', async (boundary) => {
    const step = options(`commit-boundary-${boundary}`);
    const id = `${application}-commit-boundary-${boundary}`;
    let faultsTriggered = 0;
    let completedMarkerObservedInsideTransaction = false;
    const acquireSession = first.acquireSession;
    if (!acquireSession) throw new Error('PostgreSQL session API required');
    // Fault only the public pinned-session boundary. All queries, transaction
    // state, advisory locks and termination are provided by real PostgreSQL.
    const faultingDatabase = new Proxy(first, {
      get(target, property, receiver) {
        if (property !== 'acquireSession')
          return Reflect.get(target, property, receiver);
        return async () => {
          const session = await acquireSession.call(first);
          return {
            isActive: session.isActive.bind(session),
            release: session.release.bind(session),
            query: async (sql: string, ...vars: unknown[]) => {
              if (
                sql.trim().toUpperCase() !== 'COMMIT' ||
                faultsTriggered > 0
              ) {
                return session.query(sql, ...vars);
              }
              faultsTriggered++;
              const marker = await session.query(
                'SELECT status FROM _smrt_deployment_steps WHERE application = ? AND environment = ? AND step_id = ?',
                step.application,
                step.environment,
                step.stepId,
              );
              completedMarkerObservedInsideTransaction =
                marker.rows[0]?.status === 'complete';
              expect(completedMarkerObservedInsideTransaction).toBe(true);
              expect(
                (
                  await session.query(
                    'SELECT id FROM _smrt_deployment_test_values WHERE id = ?',
                    id,
                  )
                ).rows,
              ).toHaveLength(1);
              const pid = (
                await session.query('SELECT pg_backend_pid() AS pid')
              ).rows[0].pid;
              if (boundary === 'after-commit') {
                await session.query(sql, ...vars);
                // The server committed; only the acknowledgement to the API
                // is lost. An independent connection proves durability first.
                expect(
                  (await new DeploymentPhaseTracker(second).getStepStatus(step))
                    ?.status,
                ).toBe('complete');
                expect(
                  (
                    await second.query(
                      'SELECT id FROM _smrt_deployment_test_values WHERE id = ?',
                      id,
                    )
                  ).rows,
                ).toHaveLength(1);
              }
              const killed = await second.query(
                'SELECT pg_terminate_backend(?) AS terminated',
                pid,
              );
              expect(killed.rows[0].terminated).toBe(true);
              throw new Error(
                `simulated lost COMMIT acknowledgement: ${boundary}`,
              );
            },
          };
        };
      },
    });
    const work = vi.fn(async (tx: DeploymentStepTransaction) => {
      await tx.query(
        'INSERT INTO _smrt_deployment_test_values VALUES (?, 1)',
        id,
      );
    });
    await expect(
      new DeploymentPhaseTracker(faultingDatabase).runTransactionalStep(
        step,
        work,
      ),
    ).rejects.toThrow(`simulated lost COMMIT acknowledgement: ${boundary}`);
    expect(faultsTriggered).toBe(1);
    expect(completedMarkerObservedInsideTransaction).toBe(true);
    const observer = new DeploymentPhaseTracker(second);
    const afterFault = await observer.getStepStatus(step);
    const afterFaultData = await second.query(
      'SELECT id FROM _smrt_deployment_test_values WHERE id = ?',
      id,
    );
    if (boundary === 'before-send') {
      expect(afterFault).toBeNull();
      expect(afterFaultData.rows).toHaveLength(0);
    } else {
      expect(afterFault?.status).toBe('complete');
      expect(afterFaultData.rows).toHaveLength(1);
    }
    await tracker.runTransactionalStep(step, work);
    await tracker.runTransactionalStep(step, work);
    expect(work).toHaveBeenCalledTimes(boundary === 'before-send' ? 2 : 1);
    expect((await observer.getStepStatus(step))?.status).toBe('complete');
    expect(
      (
        await second.query(
          'SELECT id FROM _smrt_deployment_test_values WHERE id = ?',
          id,
        )
      ).rows,
    ).toHaveLength(1);
  });
});
