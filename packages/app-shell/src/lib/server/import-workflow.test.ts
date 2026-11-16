import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  config,
  createTrackedAiClient,
  getRunTrajectory,
} from '@happyvertical/smrt-core';
import {
  SmrtJobCollection,
  SmrtWorkerCollection,
  TaskRunner,
  unregisterLiveWorker,
} from '@happyvertical/smrt-jobs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  businessBytes,
  businessWorkbook,
} from '../../../test-support/import-workbook.ts';
import {
  importFieldName,
  importModelName,
} from '../../engine/import-target.ts';
import { AppImportCollection } from '../objects/AppImport.ts';
import { ApprovalCollection } from '../objects/Approval.ts';
import {
  discardNow,
  draftInfo,
  previewDraft,
  requestPublish,
  startDraft,
} from './drafts.ts';
import {
  closeHost,
  configureShell,
  getDraftSlot,
  getHost,
  hostFor,
} from './host.ts';
import { IMPORT_MAX_BYTES, importSettings } from './import-settings.ts';
import {
  createShellImportService,
  readUpload,
  workbookFacts,
} from './import-workflow.ts';
import { runAs } from './owner.ts';
import { openShell, type ShellHarness } from './test-support.ts';

let h: ShellHarness;
let service: ReturnType<typeof createShellImportService>;
let runners: TaskRunner[];
let answer: (index: number) => unknown | Promise<unknown>;
let calls: number;
let texts: string[];
let release: (() => void) | undefined;
const request = async (bad = false, badCache = false) =>
  new Request('http://shell/api/shell/import', {
    method: 'POST',
    body: (await businessBytes(bad, badCache)) as BodyInit,
  });
const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>) {
  for (let n = 0; n < 1000; n++) {
    if (await check()) return;
    await pause();
  }
  throw new Error('Import did not reach the expected state');
}
const install = () =>
  createShellImportService({
    db: h.db,
    root: h.dir,
    ready: async () => {},
    tracked: (owner) =>
      createTrackedAiClient({
        db: h.db,
        tenantId: owner.tenantId,
        ai: {
          embed: async () => [],
          message: async (text: string) => {
            texts.push(text);
            const output = await answer(calls++);
            return {
              content: JSON.stringify(output),
              model: 'scripted',
              usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
            };
          },
        } as never,
      }),
  });
async function worker(extra: ConstructorParameters<typeof TaskRunner>[0] = {}) {
  const runner = new TaskRunner({
    claimFencing: true,
    concurrency: 1,
    pollInterval: 10,
    cancelPollInterval: 10,
    retention: false,
    ...extra,
  });
  runners.push(runner);
  await runner.initialize(h.db);
  await runner.start();
  return runner;
}
async function end() {
  await until(async () =>
    ['done', 'failed', 'cancelled', 'stopped'].includes(
      (await service.current(h.owner))?.state ?? '',
    ),
  );
  return (await service.current(h.owner))!;
}
beforeEach(async () => {
  h = await openShell();
  runners = [];
  calls = 0;
  texts = [];
  release = undefined;
  answer = () => businessWorkbook().plan;
  service = install();
});
afterEach(async () => {
  release?.();
  for (const runner of runners) await runner.stop();
  service.dispose();
  config({ usage: { enabled: true, persist: true } });
  await h.close();
  vi.restoreAllMocks();
});
it('loads and proves a workbook as one tracked background workflow and leaves only a reviewable draft', async () => {
  const run = await service.start(h.owner, await request());
  expect(calls).toBe(0);
  await worker();
  const current = await end();
  expect(current.state).toBe('done');
  expect(current.status).toBe('review');
  expect(current.proof?.ok).toBe(true);
  expect((await draftInfo())?.publishable).toBe(true);
  expect(Object.keys((await getHost()).describe().models)).toEqual([]);
  expect(
    await (await hostFor('draft')).countRows(importModelName('orders')),
  ).toBe(2);
  const events = await getRunTrajectory(h.db, run.id);
  expect(events?.entries.some(({ event }) => event?.type === 'call')).toBe(
    true,
  );
  expect(texts[0]).toContain('Workbook facts');
  expect(texts[0]).toContain('headerRowCandidates');
  const preview = await previewDraft();
  expect(preview.preview.digest).toBeTruthy();
  const rows = await (await AppImportCollection.create({ db: h.db })).list();
  const file = join(h.dir, 'imports', `${rows[0].id}.xlsx`);
  expect(existsSync(file)).toBe(true);
  await service.action(h.owner, 'discard');
  expect(await getDraftSlot()).toBeNull();
  expect(existsSync(file)).toBe(false);
});
it('repeats a checked plan with bounded findings then accepts a corrected plan', async () => {
  answer = (index) => {
    const plan = businessWorkbook().plan;
    if (!index) plan.tables[0].source.sheet = 'Missing';
    return plan;
  };
  await service.start(h.owner, await request());
  await worker();
  const current = await end();
  expect(current.state).toBe('done');
  expect(calls).toBe(2);
  expect(texts[1]).toContain('sheet-missing');
});
it('fails check_failed after three repeats and keeps workbook findings', async () => {
  answer = () => {
    const plan = businessWorkbook().plan;
    plan.tables[0].source.sheet = 'Missing';
    return plan;
  };
  await service.start(h.owner, await request());
  await worker();
  const current = await end();
  expect(current.state).toBe('failed');
  expect(current.stopReason).toBe('check_failed');
  expect(calls).toBe(4);
  expect(current.findings?.some((f) => f.code === 'sheet-missing')).toBe(true);
  expect(await getDraftSlot()).toBeNull();
});
it('discards a draft whose calculated result fails proof', async () => {
  await service.start(h.owner, await request(false, true));
  await worker();
  const current = await end();
  expect(current.state).toBe('failed');
  expect(current.findings?.some((f) => f.code === 'calculated-mismatch')).toBe(
    true,
  );
  expect(await getDraftSlot()).toBeNull();
  expect(Object.keys((await getHost()).describe().models)).toEqual([]);
});
it('holds edits and publishing during a partial load; a repeated check discards its prior draft', async () => {
  const original = (await import('../../engine/host.ts')).AppHost.prototype
    .execute;
  let once = true;
  vi.spyOn(
    (await import('../../engine/host.ts')).AppHost.prototype,
    'execute',
  ).mockImplementation(async function (
    this: import('../../engine/host.ts').AppHost,
    command,
    options,
  ) {
    const result = await original.call(this, command, options);
    if (once && command.type === 'loadRecords') {
      once = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return result;
  });
  const run = await service.start(h.owner, await request());
  await worker();
  await until(async () => !!release);
  const firstId = (await getDraftSlot())!.id;
  expect((await draftInfo())?.publishable).toBe(false);
  await expect(previewDraft()).rejects.toThrow(/still being checked/);
  await expect(hostFor('draft')).rejects.toThrow(/still being checked/);
  await service.action(h.owner, 'stop');
  release?.();
  await end();
  await service.action(h.owner, 'resume');
  const current = await end();
  expect(current.state).toBe('done');
  expect(current.draftId).not.toBe(firstId);
  expect(current.id).toBe(run.id);
  expect(
    await (await hostFor('draft')).countRows(importModelName('orders')),
  ).toBe(2);
});
it('recovers a dead worker with a second runner, repeats the in-flight step and fences its late return', async () => {
  let once = true;
  answer = async () => {
    if (once) {
      once = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return businessWorkbook().plan;
  };
  const started = await service.start(h.owner, await request());
  const first = await worker({ shutdownTimeout: 1, leaseTickMs: 10000 });
  await until(async () => !!release);
  const jobs = await SmrtJobCollection.create({ db: h.db });
  const prior = (
    await jobs.list({ where: { dedupeKey: started.id, status: 'running' } })
  )[0];
  expect(prior?.workerId).toBeTruthy();
  await first.stop();
  unregisterLiveWorker(prior.workerId as string);
  await (await SmrtWorkerCollection.create({ db: h.db })).expireWorker(
    prior.workerId as string,
  );
  service.dispose();
  await closeHost();
  configureShell({ db: async () => h.db, dataRoot: async () => h.dir });
  service = install();
  await worker();
  await service.recover();
  const current = await end();
  expect(current.state).toBe('done');
  expect(calls).toBe(2);
  expect(
    await (await hostFor('draft')).countRows(importModelName('orders')),
  ).toBe(2);
  release?.();
  await until(async () => first.activeJobCount() === 0);
  expect((await service.current(h.owner))?.state).toBe('done');
  expect(
    await (await hostFor('draft')).countRows(importModelName('orders')),
  ).toBe(2);
});
it('cancels finally and removes the owned file and draft', async () => {
  answer = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return businessWorkbook().plan;
  };
  await service.start(h.owner, await request());
  await worker();
  await until(async () => !!release);
  await service.action(h.owner, 'cancel');
  release?.();
  const current = await end();
  expect(current.state).toBe('cancelled');
  await expect(service.action(h.owner, 'resume')).rejects.toThrow(
    /cannot resume/,
  );
  expect(await getDraftSlot()).toBeNull();
});
it('refuses nonowners, invalid uploads, occupied draft and simultaneous imports', async () => {
  await expect(service.start(h.member, await request())).rejects.toThrow(
    /owner/,
  );
  await expect(
    service.start(
      h.owner,
      new Request('http://shell/import', {
        method: 'POST',
        body: 'not a workbook',
      }),
    ),
  ).rejects.toMatchObject({ status: 415 });
  await startDraft('My draft', h.owner.id);
  await expect(service.start(h.owner, await request())).rejects.toMatchObject({
    status: 409,
  });
  await discardNow();
  await service.start(h.owner, await request());
  await expect(service.start(h.owner, await request())).rejects.toMatchObject({
    status: 409,
  });
  expect(await service.current(h.member).catch(() => null)).toBeNull();
});
it('refuses tracking-off and disconnected AI before consuming bytes, and validates owner cell settings', async () => {
  config({ usage: { enabled: false } });
  const req = await request();
  await expect(service.start(h.owner, req)).rejects.toThrow(/usage tracking/);
  expect(req.bodyUsed).toBe(false);
  config({ usage: { enabled: true } });
  service.dispose();
  service = createShellImportService({
    db: h.db,
    root: h.dir,
    ready: async () => {
      throw new Error('unavailable');
    },
  });
  await expect(service.start(h.owner, req)).rejects.toThrow(/Connect an AI/);
  expect(req.bodyUsed).toBe(false);
  expect((await importSettings(h.owner)).maxCells).toBe(250000);
  await expect(importSettings(h.owner, 999)).rejects.toMatchObject({
    status: 400,
  });
  expect(await importSettings(h.owner, 1000)).toEqual({ maxCells: 1000 });
});
it('bounds raw upload bytes before parsing, and limits facts independently of row count', async () => {
  await expect(
    readUpload(
      new Request('http://shell/import', {
        method: 'POST',
        headers: { 'content-length': String(IMPORT_MAX_BYTES + 1) },
        body: 'x',
      }),
    ),
  ).rejects.toMatchObject({ status: 413 });
  const facts = workbookFacts(businessWorkbook().workbook, 250000);
  expect(facts.length).toBeLessThan(120000);
  expect(facts).toContain('formula');
});

vi.mock('./import-runtime.ts', () => ({ shellImports: async () => service }));
it('gates the upload/status/control/settings routes by owner, active tenant and same origin', async () => {
  const route = await import('../../routes/api/shell/import/+server.ts');
  const control = await import(
    '../../routes/api/shell/import/[action]/+server.ts'
  );
  const settings = await import(
    '../../routes/api/shell/import/settings/+server.ts'
  );
  const event = (
    request: Request,
    who: typeof h.owner | null = h.owner,
    action = 'stop',
  ) =>
    ({
      request,
      url: new URL(request.url),
      locals: who
        ? { user: { id: who.id }, tenantId: who.tenantId, permissions: [] }
        : {},
      params: { action },
    }) as never;
  const getReq = () => new Request('http://shell/api/shell/import');
  expect((await route.GET(event(getReq(), null))).status).toBe(401);
  expect((await route.GET(event(getReq(), h.member))).status).toBe(403);
  expect(
    (await route.GET(event(getReq(), { ...h.owner, tenantId: 'other-tenant' })))
      .status,
  ).toBe(403);
  expect(
    (
      await route.POST(
        event(
          new Request('http://shell/api/shell/import', {
            method: 'POST',
            headers: { origin: 'http://elsewhere' },
            body: 'x',
          }),
        ),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await route.POST(
        event(
          new Request('http://shell/api/shell/import', {
            method: 'POST',
            body: 'x',
          }),
        ),
      )
    ).status,
  ).toBe(415);
  expect((await route.POST(event(await request()))).status).toBe(202);
  const status = await route.GET(event(getReq()));
  expect(status.status).toBe(200);
  expect((await status.json()).import.id).toBeTruthy();
  expect(
    (
      await control.POST(
        event(
          new Request('http://shell/api/shell/import/cancel', {
            method: 'POST',
          }),
          h.owner,
          'cancel',
        ),
      )
    ).status,
  ).toBe(200);
  const setting = new Request('http://shell/api/shell/import/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maxCells: 1500 }),
  });
  expect((await settings.POST(event(setting))).status).toBe(200);
  expect((await (await settings.GET(event(getReq()))).json()).maxCells).toBe(
    1500,
  );
});
it('refuses a workbook over the configured cell limit before starting a run', async () => {
  await importSettings(h.owner, 1000);
  const { workbook } = businessWorkbook();
  for (let n = 10; n < 1100; n++)
    workbook.sheets[0].cells.set(n, 1, { value: 'extra', type: 'text' });
  const { getSpreadsheets } = await import('@happyvertical/spreadsheets');
  const bytes = await (await getSpreadsheets({ type: 'xlsx' })).write(workbook);
  await expect(
    service.start(
      h.owner,
      new Request('http://shell/import', {
        method: 'POST',
        body: bytes as BodyInit,
      }),
    ),
  ).rejects.toMatchObject({ status: 413 });
  expect(await service.current(h.owner)).toBeNull();
});
it('publishes imported records only through the existing owner draft approval, then removes the file', async () => {
  await service.start(h.owner, await request());
  await worker();
  await end();
  const before = await (await AppImportCollection.create({ db: h.db })).list();
  const file = join(h.dir, 'imports', `${before[0].id}.xlsx`);
  const preview = await previewDraft();
  const pending = await requestPublish(preview.preview.digest, h.owner.id);
  expect(Object.keys((await getHost()).describe().models)).toEqual([]);
  const approval = await (await ApprovalCollection.create({ db: h.db })).get(
    pending.approvalId,
  );
  expect(approval).toBeTruthy();
  const result = await runAs(h.owner, () => approval!.decide(true));
  expect(result.status).toBe('approved');
  expect(await (await getHost()).countRows(importModelName('orders'))).toBe(2);
  expect(
    (await (await getHost()).list(importModelName('orders')))
      .map((r) => r[importFieldName('total')])
      .sort(),
  ).toEqual([1500, 2500]);
  await until(
    async () => (await service.current(h.owner))?.status === 'published',
  );
  expect(existsSync(file)).toBe(false);
  expect(await getDraftSlot()).toBeNull();
});
it('repairs a crash between job admission and saving the import run id with idempotent start', async () => {
  const started = await service.start(h.owner, await request());
  const row = (
    await (await AppImportCollection.create({ db: h.db })).list()
  )[0];
  row.runId = '';
  row.status = 'reading';
  await row.save();
  service.dispose();
  service = install();
  await service.recover();
  expect((await service.current(h.owner))?.id).toBe(started.id);
  await worker();
  expect((await end()).state).toBe('done');
  expect(calls).toBe(1);
});
it('never discards an unrelated draft if it opens while an import job is still pending', async () => {
  await service.start(h.owner, await request());
  const other = await startDraft('Other draft', h.owner.id);
  await worker();
  expect((await end()).state).toBe('failed');
  expect((await getDraftSlot())?.id).toBe(other.id);
});
it('reports workbook error cells without ever creating a load draft', async () => {
  await service.start(h.owner, await request(true));
  await worker();
  const current = await end();
  expect(current.state).toBe('failed');
  expect(
    current.findings?.some(
      (finding) => finding.code === 'coerce-failed' && finding.cell === 'B4',
    ),
  ).toBe(true);
  expect(await getDraftSlot()).toBeNull();
});
