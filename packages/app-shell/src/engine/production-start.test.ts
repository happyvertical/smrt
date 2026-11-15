// The engine builds app.db's schema itself and never runs core's migrate, so
// core's startup check (#4927) must not refuse it in a production build. The
// worker inherits this process's environment, so NODE_ENV=production here is
// what the desktop sidecar's worker sees.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRuntimeReportSpec } from '@happyvertical/smrt-reports';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AppHost, type Command, MemoryVersionStore } from './index.ts';

const root = mkdtempSync(join(tmpdir(), 'engine-production-start-'));
const saved = {
  NODE_ENV: process.env.NODE_ENV,
  SMRT_ALLOW_UNMIGRATED_START: process.env.SMRT_ALLOW_UNMIGRATED_START,
};
let live: AppHost;
const run = (host: AppHost, cmd: Command) =>
  host.execute(cmd, { author: 't', approved: true });

beforeAll(async () => {
  process.env.NODE_ENV = 'production';
  delete process.env.SMRT_ALLOW_UNMIGRATED_START;
  live = await AppHost.open(join(root, 'live'), {
    store: new MemoryVersionStore(),
  });
  await run(live, {
    type: 'defineModel',
    name: 'Note',
    fields: { title: { type: 'text' }, size: { type: 'integer' } },
  });
});
afterAll(async () => {
  await live?.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

it('reads and writes app.db through core collections under NODE_ENV=production', async () => {
  const created = await live.create('Note', { title: 'first', size: 2 });
  expect(created.title).toBe('first');
  expect((await live.list('Note')).map((row) => row.title)).toEqual(['first']);
  expect((await live.get('Note', String(created.id)))?.size).toBe(2);
});

it('covers a draft copy and the read-only report worker', async () => {
  await run(live, {
    type: 'defineReport',
    name: 'sizes',
    definition: {
      spec: parseRuntimeReportSpec({
        version: 1,
        title: 'Sizes',
        source: 'Note',
        dimensions: [],
        measures: [{ fn: 'sum', field: 'size', as: 'total' }],
      }),
    },
  });
  expect((await live.runReport('sizes')).rowCount).toBe(1);
  const draft = await live.forkDraft(join(root, 'draft'), {
    store: new MemoryVersionStore(),
  });
  try {
    const row = await draft.create('Note', { title: 'draft only', size: 5 });
    expect((await draft.get('Note', String(row.id)))?.title).toBe('draft only');
    expect((await draft.list('Note')).length).toBe(2);
  } finally {
    await draft.discard();
  }
});
