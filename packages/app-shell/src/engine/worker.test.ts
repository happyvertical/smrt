import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppHost,
  EngineError,
  MemoryVersionStore,
  WorkerCrashedError,
} from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'engine-worker-'));
const store = new MemoryVersionStore();
let host: AppHost;

beforeAll(async () => {
  host = await AppHost.open(dir, { store });
  await host.execute(
    { type: 'defineModel', name: 'Chore', fields: { title: { type: 'text' } } },
    { author: 't' },
  );
  await host.create('Chore', { title: 'kept' });
});
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('worker robustness', () => {
  it('calls fail cleanly once the worker crashed, and restartApp recovers', async () => {
    expect(host.appAlive).toBe(true);
    await host.killApp();
    await new Promise((r) => setTimeout(r, 50));
    expect(host.appAlive).toBe(false);
    for (const call of [
      () => host.list('Chore'),
      () => host.create('Chore', { title: 'x' }),
      () => host.appTools(),
      () => host.rest({ method: 'GET', url: '/api/chores' }),
      () => host.plan({ type: 'removeField', model: 'Chore', field: 'title' }),
    ]) {
      const err = await call().then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(WorkerCrashedError);
      expect((err as EngineError).code).toBe('worker_crashed');
    }
    // history and definition are still readable without the app
    expect(host.describe().models.Chore).toBeTruthy();
    expect((await host.versions()).length).toBeGreaterThan(0);

    await host.restartApp();
    expect(host.appAlive).toBe(true);
    const rows = await host.list('Chore');
    expect(rows.map((r) => r.title)).toEqual(['kept']);
    await host.create('Chore', { title: 'after' });
    expect(await host.list('Chore')).toHaveLength(2);
  });

  it('changes still work after a restart and the change queue is not stuck', async () => {
    await host.execute(
      {
        type: 'addField',
        model: 'Chore',
        field: 'room',
        definition: { type: 'text' },
      },
      { author: 't' },
    );
    expect(Object.keys((await host.list('Chore'))[0])).toContain('room');
  });

  it('a worker that cannot start leaves the previous app running', async () => {
    const before = host.version;
    // a definition the app cannot start: an existing column of another type
    await host.execute(
      {
        type: 'addField',
        model: 'Chore',
        field: 'tmp',
        definition: { type: 'text' },
      },
      { author: 't' },
    );
    await host.execute({ type: 'undo' }, { author: 't' });
    await expect(
      host.execute(
        {
          type: 'addField',
          model: 'Chore',
          field: 'tmp',
          definition: { type: 'integer' },
        },
        { author: 't' },
      ),
    ).rejects.toThrow(/already holds/);
    expect(host.version).toBe(before + 0);
    expect(host.appAlive).toBe(true);
    expect(await host.list('Chore')).toHaveLength(2);
  });

  it('a closed host refuses further work', async () => {
    const other = await AppHost.open(
      mkdtempSync(join(tmpdir(), 'engine-worker2-')),
      {
        store: new MemoryVersionStore(),
      },
    );
    await other.close();
    await expect(other.list('Chore')).rejects.toBeInstanceOf(EngineError);
    await expect(
      other.execute({ type: 'undo' }, { author: 't' }),
    ).rejects.toBeInstanceOf(EngineError);
  });

  it('events: changed and records', async () => {
    const seen: string[] = [];
    host.on('changed', (e) => seen.push(`c:${e.summary}`));
    host.on('records', (e) => seen.push(`r:${e.model}`));
    await host.create('Chore', { title: 'ev' });
    await host.restartApp();
    expect(seen).toEqual(['r:Chore', 'c:app restarted']);
  });
});
