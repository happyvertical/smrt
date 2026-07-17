/**
 * Regression for #2038: object-bound jobs must hydrate the persisted target
 * before invoking its method. This exercises the real persistent queue and
 * polling runner rather than calling TaskRunner internals directly.
 */
import {
  field,
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import { backgroundEligible } from '../background-policy.js';
import { createTaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';

interface ProbeResult {
  id: string | null | undefined;
  label: string;
  processedMarker: string;
}

@smrt()
class ObjectJobHydrationProbe extends SmrtObject {
  static invocationIds: string[] = [];

  @field({ type: 'text', required: true })
  label: string = '';

  @field({ type: 'text' })
  processedMarker: string = '';

  private readonly agentMarker: string;

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    this.agentMarker = String(options.agentMarker ?? 'missing-agent-config');
  }

  @backgroundEligible()
  async process(args: { suffix: string }): Promise<ProbeResult> {
    ObjectJobHydrationProbe.invocationIds.push(this.id ?? 'missing-id');
    this.processedMarker = `${this.label}:${args.suffix}:${this.agentMarker}`;
    await this.save();

    return {
      id: this.id,
      label: this.label,
      processedMarker: this.processedMarker,
    };
  }
}

function canonicalProbeType(): string {
  return (
    ObjectRegistry.getClass('ObjectJobHydrationProbe')?.qualifiedName ||
    'ObjectJobHydrationProbe'
  );
}

afterEach(() => {
  ObjectJobHydrationProbe.invocationIds.length = 0;
  ObjectRegistry.clearCollectionCache?.();
});

describe('TaskRunner object-bound job hydration (#2038)', () => {
  it('hydrates the exact persisted row and invokes its method with agent config', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });

    const target = await new ObjectJobHydrationProbe({
      db,
      label: 'target-row',
    }).initialize();
    await target.save();

    const other = await new ObjectJobHydrationProbe({
      db,
      label: 'other-row',
    }).initialize();
    await other.save();

    const targetId = target.id;
    const otherId = other.id;
    if (!targetId || !otherId) {
      throw new Error('persisted probes must have IDs');
    }

    const jobs = await SmrtJobCollection.create({ db });
    const job = await jobs.create({
      objectType: canonicalProbeType(),
      objectId: targetId,
      method: 'process',
      args: {
        suffix: 'ran',
        _agentConfig: {
          agentMarker: 'resolved-config',
          db: ':memory:',
          id: otherId,
          _skipLoad: true,
        },
      },
      maxAttempts: 1,
    });
    await job.save();

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);

    const completion = new Promise<{ result?: ProbeResult }>(
      (resolve, reject) => {
        runner.once('job:completed', (_completedJob, result) =>
          resolve(result as { result?: ProbeResult }),
        );
        runner.once('job:failed', (_failedJob, error) => reject(error));
        runner.once('runner:error', reject);
      },
    );

    await runner.start();
    try {
      const { result } = await completion;
      expect(result).toEqual({
        id: targetId,
        label: 'target-row',
        processedMarker: 'target-row:ran:resolved-config',
      });
    } finally {
      await runner.stop();
    }

    const hydratedTarget = await new ObjectJobHydrationProbe({
      db,
      id: targetId,
    }).initialize();
    const hydratedOther = await new ObjectJobHydrationProbe({
      db,
      id: otherId,
    }).initialize();

    expect(hydratedTarget.processedMarker).toBe(
      'target-row:ran:resolved-config',
    );
    expect(hydratedOther.processedMarker).toBe('');
  });

  it('fails a stale object-bound job before invoking its method', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });

    const target = await new ObjectJobHydrationProbe({
      db,
      label: 'deleted-row',
    }).initialize();
    await target.save();

    const targetId = target.id;
    if (!targetId) {
      throw new Error('persisted probe must have an ID');
    }
    await target.delete();

    const jobs = await SmrtJobCollection.create({ db });
    const job = await jobs.create({
      objectType: canonicalProbeType(),
      objectId: targetId,
      method: 'process',
      args: { suffix: 'must-not-run' },
      maxAttempts: 1,
    });
    await job.save();

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);

    const failure = new Promise<Error>((resolve, reject) => {
      runner.once('job:failed', (_failedJob, error) => resolve(error));
      runner.once('job:completed', () =>
        reject(new Error('stale object-bound job unexpectedly completed')),
      );
      runner.once('runner:error', reject);
    });

    await runner.start();
    try {
      const error = await failure;
      expect(error.message).toBe(
        `Object-bound job target not found: ${canonicalProbeType()}#${targetId}`,
      );
    } finally {
      await runner.stop();
    }

    expect(ObjectJobHydrationProbe.invocationIds).toEqual([]);
  });
});
