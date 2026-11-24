// The engine builds app.db's schema itself and never runs core's migrate, so
// core's startup check (#4927) must not refuse it in a production build. The
// worker inherits this process's environment, so NODE_ENV=production here is
// what the desktop sidecar's worker sees.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRuntimeReportSpec } from '@happyvertical/smrt-reports';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import { AppHost, type Command, MemoryVersionStore } from './index.ts';
import { onPglite } from './pglite-env.ts';

const root = mkdtempSync(join(tmpdir(), 'engine-production-start-'));
const saved = {
  NODE_ENV: process.env.NODE_ENV,
  SMRT_ALLOW_UNMIGRATED_START: process.env.SMRT_ALLOW_UNMIGRATED_START,
};
let live: AppHost;
const run = (host: AppHost, cmd: Command) =>
  host.execute(hostOwner(host), cmd, { author: 't', approved: true });

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
  const created = await live.create(hostOwner(live), 'Note', {
    title: 'first',
    size: 2,
  });
  expect(created.title).toBe('first');
  expect(
    (await live.list(hostOwner(live), 'Note')).map((row) => row.title),
  ).toEqual(['first']);
  expect(
    (await live.get(hostOwner(live), 'Note', String(created.id)))?.size,
  ).toBe(2);
});

it('covers a draft copy and the read-only report worker', {
  skip: onPglite,
}, async () => {
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
  expect((await live.runReport(hostOwner(live), 'sizes')).rowCount).toBe(1);
  const draft = await live.forkDraft(hostOwner(live), join(root, 'draft'), {
    store: new MemoryVersionStore(),
  });
  try {
    const row = await draft.create(hostOwner(draft), 'Note', {
      title: 'draft only',
      size: 5,
    });
    expect(
      (await draft.get(hostOwner(draft), 'Note', String(row.id)))?.title,
    ).toBe('draft only');
    expect((await draft.list(hostOwner(draft), 'Note')).length).toBe(2);
  } finally {
    await draft.discard();
  }
});

// The engine runs table changes and _archive writes inside this.db.transaction
// (a transaction handle is a new object over the same client). Each case below
// boots a worker (a new one per definition change) or a rehearsal copy that
// must declare its own handle, under NODE_ENV=production.
it('boots a new worker with a migration, then reads and writes the added field', async () => {
  const before = await live.create(hostOwner(live), 'Note', {
    title: 'pre-migration',
    size: 1,
  });
  await run(live, {
    type: 'addField',
    model: 'Note',
    field: 'rank',
    definition: { type: 'integer' },
  });
  const after = await live.create(hostOwner(live), 'Note', {
    title: 'post',
    size: 3,
    rank: 7,
  });
  expect(
    (await live.get(hostOwner(live), 'Note', String(after.id)))?.rank,
  ).toBe(7);
  expect(
    (await live.get(hostOwner(live), 'Note', String(before.id)))?.title,
  ).toBe('pre-migration');
});

it('undoes the migration (the down steps), then reads', async () => {
  await run(live, { type: 'undo' });
  const rows = await live.list(hostOwner(live), 'Note');
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.some((row) => row.title === 'post')).toBe(true);
  expect(live.def.models.Note.fields.rank).toBeUndefined();
});

it('publishes a draft that adds a field and reads it from live', {
  skip: onPglite,
}, async () => {
  const publishRoot = join(root, 'publish');
  const host = await AppHost.open(join(publishRoot, 'live'), {
    store: new MemoryVersionStore(),
  });
  try {
    await run(host, {
      type: 'defineModel',
      name: 'Chore',
      fields: { title: { type: 'text' } },
    });
    await host.create(hostOwner(host), 'Chore', { title: 'Bins' });
    const draft = await host.forkDraft(
      hostOwner(host),
      join(publishRoot, 'draft'),
      {
        store: new MemoryVersionStore(),
      },
    );
    host.setFrozen(true);
    await run(draft, {
      type: 'addField',
      model: 'Chore',
      field: 'points',
      definition: { type: 'integer' },
    });
    const preview = await host.previewPublish(draft);
    await host.publishDraft(hostOwner(host), draft, {
      author: 't',
      approved: true,
      expect: preview.digest,
    });
    const row = await host.create(hostOwner(host), 'Chore', {
      title: 'Dishes',
      points: 5,
    });
    expect(
      (await host.get(hostOwner(host), 'Chore', String(row.id)))?.points,
    ).toBe(5);
    await draft.close().catch(() => {});
  } finally {
    await host.close();
  }
});
