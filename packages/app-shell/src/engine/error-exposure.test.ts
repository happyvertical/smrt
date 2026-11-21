// What an owner may be shown when a worker's or a driver's text travels through
// the engine (#5464). A worker that fails to start says what the driver said
// (a host, a role); every engine error that embeds that text must stay marked
// `untrusted`, so the owner-facing layers can hide it.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { errorResponse } from '../lib/server/http.ts';
import { ownerMessage } from '../lib/server/owner-errors.ts';
import { createSqliteChangeEngine, replayFailure } from './change-engine.ts';
import {
  CapacityError,
  EngineError,
  embedding,
  UNTRUSTED_MESSAGE,
  WorkerCrashedError,
} from './errors.ts';
import { AppHost, MemoryVersionStore } from './index.ts';

const DRIVER =
  'connect ECONNREFUSED db.internal.example:5432; password authentication failed for user "svc_app"';
const LEAK = /db\.internal|svc_app|ECONNREFUSED|password authentication/;

describe('embedding', () => {
  it('keeps the flag when what it embeds is not ours, and only then', () => {
    const wrap = (...inner: unknown[]) =>
      embedding('x', 'migration_failed', ...inner).untrusted;
    expect(wrap(new Error(DRIVER))).toBe(true);
    expect(wrap(EngineError.untrusted(DRIVER))).toBe(true);
    expect(wrap(new WorkerCrashedError(DRIVER, true))).toBe(true);
    expect(wrap(new EngineError('ours'), new Error(DRIVER))).toBe(true);
    expect(wrap(new EngineError('ours'))).toBe(false);
  });
});

describe('a blocker built from a failed rehearsal', () => {
  const chain = { versions: [{ summary: 'Add Task', version: 3 }] } as never;
  const raw = `"Add Task" from the draft does not apply to the current data, so nothing was published: ${DRIVER}`;
  it('drops the reason when it is a worker or driver text', () => {
    const b = replayFailure(raw, chain, true);
    expect(b.message).not.toMatch(LEAK);
    expect(b.versions).toEqual([3]);
  });
  it('keeps our own reason', () => {
    const b = replayFailure(
      '"Add Task" from the draft is invalid: a field is missing',
      chain,
      false,
    );
    expect(b.message).toContain('a field is missing');
  });
});

describe('a worker that cannot start during a swap', () => {
  let dir: string;
  let url: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'exposure-'));
    url = join(dir, 'stub.mjs');
    const real = pathToFileURL(join(import.meta.dirname, 'app-worker.ts')).href;
    // Version 0 starts for real; any later one fails the way a driver fails.
    writeFileSync(
      url,
      `import { parentPort, workerData as w } from 'node:worker_threads';
       if (w.version >= 1)
         parentPort.postMessage({ ready: false, error: ${JSON.stringify(DRIVER)} });
       else await import(${JSON.stringify(real)});`,
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reaches the owner as a fixed sentence, with the detail logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = await AppHost.open(join(dir, 'app'), {
      store: new MemoryVersionStore(),
      workerUrl: url,
    });
    const err = await host
      .execute(
        { type: 'defineModel', name: 'Task', fields: {} },
        { author: 't' },
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.code).toBe('migration_failed');
    expect(err.untrusted).toBe(true);
    expect(ownerMessage(err)).toBe(UNTRUSTED_MESSAGE);
    expect(await errorResponse(err).text()).not.toMatch(LEAK);
    expect(
      log.mock.calls.some((c) => c.join(' ').includes('db.internal.example')),
    ).toBe(true);
    log.mockRestore();
    await host.close().catch(() => {});
  });
});

it('a capacity refusal is an engine refusal of its own kind', () => {
  const e = new CapacityError('no room');
  expect(e).toBeInstanceOf(EngineError);
  expect(e.code).toBe('refused');
});

describe('a failure inside undo and inside a publish rehearsal', () => {
  let dir: string;
  let url: string;
  let flag: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'exposure2-'));
    url = join(dir, 'stub.mjs');
    flag = join(dir, 'fail-all');
    const real = pathToFileURL(join(import.meta.dirname, 'app-worker.ts')).href;
    // Starts for real, except while the flag file exists and for a publish
    // rehearsal, where it fails the way a driver fails.
    writeFileSync(
      url,
      `import { existsSync } from 'node:fs';
       import { parentPort, workerData as w } from 'node:worker_threads';
       if (existsSync(${JSON.stringify(flag)}) || String(w.dataDir).includes('publish-rehearsal') ||
          (String(w.dataDir).includes('swapfail') && w.version >= 2))
         parentPort.postMessage({ ready: false, error: ${JSON.stringify(DRIVER)} });
       else await import(${JSON.stringify(real)});`,
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const open = (name: string) =>
    AppHost.open(join(dir, name), {
      store: new MemoryVersionStore(),
      workerUrl: url,
    });
  const as = { author: 't', approved: true };

  it('undo does not turn a worker failure back into our own message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = await open('undo');
    await host.execute({ type: 'defineModel', name: 'Task', fields: {} }, as);
    writeFileSync(flag, '');
    const err = await host
      .execute({ type: 'undoTo', version: 0 }, as)
      .catch((e) => e);
    rmSync(flag, { force: true });
    expect(err.message).toMatch(/undid 0 of/); // it is the undo's own wrapper
    expect(err.untrusted).toBe(true);
    expect(await errorResponse(err).text()).not.toMatch(LEAK);
    log.mockRestore();
    await host.close().catch(() => {});
  });

  it('a failed rehearsal is a blocker without the driver text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const engine = createSqliteChangeEngine();
    const live = await open('rehearsal');
    await live.execute({ type: 'defineModel', name: 'Chore', fields: {} }, as);
    const built = await engine.rebuild({ id: 'o' }, live, {
      draftDir: join(dir, 'rehearsal-draft'),
      store: new MemoryVersionStore(),
      commands: [
        {
          key: 'a',
          command: {
            type: 'addField',
            model: 'Chore',
            field: 'size',
            definition: { type: 'integer' },
          },
        },
      ],
      author: 't',
    });
    const check = await engine.checkBatch({ id: 'o' }, live, built.draft);
    expect(check.ok).toBe(false);
    const blocker = check.blockers.find((b) => b.code === 'replay_failed');
    expect(blocker).toBeTruthy();
    expect(JSON.stringify(check.blockers)).not.toMatch(LEAK);
    log.mockRestore();
    await built.draft.close().catch(() => {});
    await live.close().catch(() => {});
  });

  it('no connections left is a retryable refusal, not a stored blocker', async () => {
    const engine = createSqliteChangeEngine();
    const live = await open('capacity');
    await live.execute({ type: 'defineModel', name: 'Chore', fields: {} }, as);
    const built = await engine.rebuild({ id: 'o' }, live, {
      draftDir: join(dir, 'capacity-draft'),
      store: new MemoryVersionStore(),
      commands: [
        {
          key: 'a',
          command: {
            type: 'addField',
            model: 'Chore',
            field: 'size',
            definition: { type: 'integer' },
          },
        },
      ],
      author: 't',
    });
    const spy = vi
      .spyOn(live, 'previewPublish')
      .mockRejectedValue(new CapacityError('no database connections left'));
    const err = await engine
      .checkBatch({ id: 'o' }, live, built.draft)
      .catch((e) => e);
    spy.mockRestore();
    expect(err).toBeInstanceOf(CapacityError);
    const res = errorResponse(err);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no database connections left/);
    await built.draft.close().catch(() => {});
    await live.close().catch(() => {});
  });

  it('a blocker for a command that failed to apply never carries worker text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const engine = createSqliteChangeEngine();
    const live = await open('rebuild');
    await live.execute({ type: 'defineModel', name: 'Chore', fields: {} }, as);
    // The working copy's own swap fails like a driver: the blocker says so
    // in fixed words.
    const built = await engine
      .rebuild({ id: 'o' }, live, {
        draftDir: join(dir, 'swapfail-draft'),
        store: new MemoryVersionStore(),
        commands: [
          {
            key: 'a',
            command: {
              type: 'addField',
              model: 'Chore',
              field: 'size',
              definition: { type: 'integer' },
            },
          },
        ],
        author: 't',
      })
      .catch((e) => e);
    expect(built.blockers.map((b: { code: string }) => b.code)).toEqual([
      'depends_on_removed',
    ]);
    expect(JSON.stringify(built.blockers)).not.toMatch(LEAK);
    log.mockRestore();
    await built?.draft?.close?.().catch(() => {});
    await live.close().catch(() => {});
  });
});
