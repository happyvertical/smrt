import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  config,
  createTrackedAiClient,
  getAiRun,
  getRunTrajectory,
  transitionAiRun,
} from '@happyvertical/smrt-core';
import {
  SmrtJobCollection,
  SmrtWorkerCollection,
  TaskRunner,
  unregisterLiveWorker,
} from '@happyvertical/smrt-jobs';
import { getSpreadsheets } from '@happyvertical/spreadsheets';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  businessBytes,
  businessWorkbook,
  realisticBusinessWorkbook,
} from '../../../test-support/import-workbook.ts';
import {
  importFieldName,
  importModelName,
} from '../../engine/import-target.ts';
import { AppDraftCollection } from '../objects/AppDraft.ts';
import { AppImportCollection } from '../objects/AppImport.ts';
import { applyOwnBatch } from './approvals.ts';
import { runCommand } from './builder.ts';
import {
  changesState,
  flushChecks,
  removeChangeCard,
  restoreChangeCard,
} from './changes.ts';
import {
  discardIfUnused,
  discardNow,
  draftInfo,
  previewDraft,
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
let testEngine: 'api' | 'codex';
let offeredTools: unknown[][];
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
    assistant: {
      engine: async () => testEngine,
      driver: {
        async run(context, callbacks) {
          offeredTools.push([...context.tools, ...context.extraTools]);
          expect(context.principal.allowedTools).toEqual([]);
          texts.push(context.systemPrompt);
          const output = await answer(calls++);
          callbacks.done({
            text: JSON.stringify(output),
            execution: {
              engine: 'codex',
              toolCalls: 0,
              durationMs: 1,
              tokens: 10,
              inputTokens: 5,
              outputTokens: 5,
            },
          });
        },
      },
    },
    tracked: (owner) =>
      createTrackedAiClient({
        db: h.db,
        tenantId: owner.tenantId,
        ai: {
          embed: async () => [],
          chat: async (messages: { content: string }[]) => {
            texts.push(messages.map((message) => message.content).join('\n'));
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
  testEngine = 'api';
  offeredTools = [];
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
it.each([
  'tiny',
  'realistic',
] as const)('loads and proves a %s workbook as one tracked background workflow and leaves only a reviewable draft', async (size) => {
  const fixture =
    size === 'realistic' ? realisticBusinessWorkbook() : businessWorkbook();
  answer = () => fixture.plan;
  const run = await service.start(
    h.owner,
    new Request('http://shell/api/shell/import', {
      method: 'POST',
      body: (await (
        await getSpreadsheets({ type: 'xlsx' })
      ).write(fixture.workbook)) as BodyInit,
    }),
  );
  expect(calls).toBe(0);
  await worker();
  const current = await end();
  expect(current.state).toBe('done');
  expect(current.status).toBe('review');
  expect(current.proof?.ok).toBe(true);
  expect(current.plan?.engineNames?.tables.orders.model).toBe('Orders');
  expect(current.plan?.engineNames?.tables.orders.fields.customer).toBe(
    'customer',
  );
  expect((await draftInfo())?.publishable).toBe(true);
  expect(Object.keys((await getHost()).describe().models)).toEqual([]);
  expect(
    await (await hostFor('draft')).countRows(importModelName('orders')),
  ).toBe(size === 'realistic' ? 42 : 2);
  expect(current.progress?.map(({ stage }) => stage)).toEqual([
    'reading',
    'planning',
    'checking',
    'loading',
    'proving',
    'review',
  ]);
  const events = await getRunTrajectory(h.db, run.id);
  const handoff = events!.entries.flatMap(({ event }) =>
    event?.type === 'handoff' ? [event] : [],
  )[0];
  expect(handoff).toMatchObject({ status: 'done', name: 'Plan and load' });
  expect(await getAiRun(h.db, handoff.childRunId!)).toMatchObject({
    parentRunId: run.id,
    calls: 1,
    tokens: 10,
  });
  expect(await getAiRun(h.db, run.id)).toMatchObject({
    inclusiveCalls: 1,
    inclusiveTokens: 10,
  });
  expect(
    (
      await h.db.query(
        'SELECT prompt_key, tier_requested, tier_resolved FROM _smrt_ai_usage WHERE run_id = ?',
        handoff.childRunId!,
      )
    ).rows,
  ).toEqual([
    {
      prompt_key: 'app-shell.import.plan',
      tier_requested: 'best',
      tier_resolved: 'best',
    },
  ]);
  expect(texts[0]).toContain('Workbook facts');
  expect(texts[0]).toContain('headerRowCandidates');
  const preview = await previewDraft();
  expect(preview.preview.digest).toBeTruthy();
  const rows = await (await AppImportCollection.create({ db: h.db })).list();
  expect(JSON.parse(rows[0].detail).origin).toBe('http://shell');
  expect(current).not.toHaveProperty('origin');
  const file = join(h.dir, 'imports', `${rows[0].id}.xlsx`);
  expect(existsSync(file)).toBe(true);
  await service.action(h.owner, 'discard');
  expect(await getDraftSlot()).toBeNull();
  expect(existsSync(file)).toBe(false);
});
it.each([
  'api',
  'codex',
] as const)('repeats a checked plan with bounded findings then accepts a corrected plan (%s)', async (engine) => {
  testEngine = engine;
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
it.each([
  'api',
  'codex',
] as const)('fails check_failed after three repeats and keeps workbook findings (%s)', async (engine) => {
  testEngine = engine;
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
  expect(current.reason).toBe('plan');
  expect(calls).toBe(4);
  expect(current.findings?.some((f) => f.code === 'sheet-missing')).toBe(true);
  expect(await getDraftSlot()).toBeNull();
});
it.each([
  'api',
  'codex',
] as const)('keeps the file after an %s engine failure and retries it once without uploading', async (engine) => {
  testEngine = engine;
  answer = () => {
    throw new Error('private provider detail must not reach the owner');
  };
  const first = await service.start(h.owner, await request());
  await worker();
  const failure = await end();
  expect(failure).toMatchObject({
    state: 'failed',
    reason: 'engine',
    findings: [],
  });
  expect(failure.note).toContain(engine === 'codex' ? 'Codex' : 'API');
  expect(failure.note).not.toContain('private provider');
  const [row] = await (await AppImportCollection.create({ db: h.db })).list();
  const file = join(h.dir, 'imports', `${row.id}.xlsx`);
  expect(existsSync(file)).toBe(true);
  for (const runner of runners) await runner.stop();
  service.dispose();
  service = install();
  await service.recover();
  await worker();
  expect(existsSync(file)).toBe(true);
  answer = () => businessWorkbook().plan;
  await Promise.all([
    service.action(h.owner, 'retry'),
    service
      .action(h.owner, 'retry')
      .catch((error) => expect(error.status).toBe(409)),
  ]);
  const current = await end();
  expect(current.state).toBe('done');
  expect(current.id).not.toBe(first.id);
  expect((await getAiRun(h.db, current.id!))?.retryOfRunId).toBe(first.id);
  expect(
    await (await hostFor('draft')).countRows(importModelName('orders')),
  ).toBe(2);
  await service.action(h.owner, 'discard');
  expect(existsSync(file)).toBe(false);
});
it.each([
  'shape',
  'calculation',
])('keeps invalid %s output separate from workbook findings and allows a fresh plan', async (variant) => {
  answer = () => {
    if (variant === 'shape') return { wrong: 'shape' };
    const plan = businessWorkbook().plan;
    plan.tables[0].fields[3].calculated = {
      op: 'mul',
      args: [{ col: 'price' }, { col: 'quantity' }],
    } as never;
    return plan;
  };
  await service.start(h.owner, await request());
  await worker();
  const current = await end();
  expect(current).toMatchObject({
    state: 'failed',
    stopReason: 'repairs_exhausted',
    reason: 'plan',
  });
  expect(current.note).not.toContain('findings');
  expect(current.note).not.toContain('settings');
  if (variant === 'calculation') {
    expect(current.note).toContain('“Orders”, column “Total”');
    expect(current.note).toContain('translating a formula');
    expect(current.note).not.toContain('tables[0]');
    expect(current.note).not.toContain('invalid-expression');
  }
  answer = () => businessWorkbook().plan;
  await service.action(h.owner, 'retry');
  expect((await end()).state).toBe('done');
});
it.each([
  'before',
  'after',
] as const)('recovers a crash %s retry admission without creating a second retry', async (when) => {
  answer = () => {
    throw new Error('test engine unavailable');
  };
  const first = await service.start(h.owner, await request());
  await worker();
  await end();
  for (const runner of runners) await runner.stop();
  const [row] = await (await AppImportCollection.create({ db: h.db })).list();
  const attempt = randomUUID();
  row.runId = attempt;
  row.detail = JSON.stringify({
    ...JSON.parse(row.detail),
    retry: { from: first.id, id: attempt },
  });
  await row.save();
  if (when === 'after')
    await service.kit
      .forOwner(h.owner.id, h.owner.tenantId)
      .retry(first.id, { id: attempt });
  service.dispose();
  service = install();
  answer = () => businessWorkbook().plan;
  await service.recover();
  await worker();
  expect((await end()).state).toBe('done');
  expect(
    (
      await h.db.query(
        'SELECT id FROM _smrt_ai_runs WHERE retry_of_run_id = ?',
        first.id,
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    await (await hostFor('draft')).countRows(importModelName('orders')),
  ).toBe(2);
});
it.each([
  'max_tokens',
  'max_duration',
] as const)('returns a machine-readable budget reason for %s and resumes the saved input', async (stopReason) => {
  const run = await service.start(h.owner, await request());
  await transitionAiRun(h.db, run.id, {
    from: 'running',
    to: 'stopped',
    stopReason,
    stopDetail: {
      runId: run.id,
      limit: stopReason === 'max_tokens' ? 'maxTokens' : 'maxDurationMs',
      limitValue: stopReason === 'max_tokens' ? 400_000 : 1_800_000,
      used: stopReason === 'max_tokens' ? 400_000 : 1_800_000,
      room: 0,
    },
  });
  expect(await service.current(h.owner)).toMatchObject({
    state: 'stopped',
    reason: 'budget',
    stopReason,
  });
  await worker();
  await until(async () =>
    (await (await SmrtJobCollection.create({ db: h.db })).list()).every((job) =>
      ['completed', 'failed', 'cancelled'].includes(job.status),
    ),
  );
  await service.action(h.owner, 'resume');
  expect((await end()).state).toBe('done');
});
it.each([
  'api',
  'codex',
] as const)('discards a draft whose calculated result fails proof (%s)', async (engine) => {
  testEngine = engine;
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
it.each([
  'api',
  'codex',
] as const)('recovers a dead %s worker with a second runner and fences its late return', async (engine) => {
  testEngine = engine;
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
  if (engine === 'codex') expect(offeredTools).toEqual([[], []]);
  const handoffs = (await getRunTrajectory(h.db, started.id))!.entries.flatMap(
    ({ event }) => (event?.type === 'handoff' ? [event] : []),
  );
  expect(handoffs).toHaveLength(2);
  for (const handoff of handoffs) {
    const child = await getRunTrajectory(h.db, handoff.childRunId!);
    expect(child!.entries.some(({ event }) => event?.type === 'action')).toBe(
      false,
    );
  }
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
it.each([
  'api',
  'codex',
] as const)('cancels a %s planning turn finally and removes the owned file and draft', async (engine) => {
  testEngine = engine;
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
it('stops and resumes CLI planning without opening a draft from the stopped child', async () => {
  testEngine = 'codex';
  answer = async (index) => {
    if (!index)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return businessWorkbook().plan;
  };
  await service.start(h.owner, await request());
  await worker();
  await until(async () => !!release);
  await service.action(h.owner, 'stop');
  release?.();
  expect((await end()).state).toBe('stopped');
  expect(await getDraftSlot()).toBeNull();
  await service.action(h.owner, 'resume');
  expect((await end()).state).toBe('done');
  expect(offeredTools).toEqual([[], []]);
  expect(
    await (await hostFor('draft')).countRows(importModelName('orders')),
  ).toBe(2);
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
  await runAs(h.owner, () =>
    runCommand(
      {
        type: 'defineModel',
        name: 'Scratch',
        fields: { note: { type: 'text' } },
      },
      h.owner.id,
      'draft',
    ),
  );
  const refused = await service
    .start(h.owner, await request())
    .catch((e: Error) => e);
  expect(refused).toMatchObject({ status: 409 });
  expect((refused as Error).message).toMatch(
    /You have \d+ changes? waiting\. Apply or discard (it|them) before importing a workbook\./,
  );
  expect((refused as Error).message).not.toMatch(/draft|publish/i);
  expect((await draftInfo())?.name).toBe('My draft');
  await discardNow();
  await service.start(h.owner, await request());
  await expect(service.start(h.owner, await request())).rejects.toMatchObject({
    status: 409,
  });
  expect(await service.current(h.member).catch(() => null)).toBeNull();
});
it('reuses an open draft that has no changes', async () => {
  const unused = await startDraft('Never used', h.owner.id);
  await service.start(h.owner, await request());
  expect(
    (await (await AppDraftCollection.create({ db: h.db })).get(unused.id))
      ?.status,
  ).toBe('discarded');
});
it('keeps a draft whose edit lands as the unused discard begins (#5122)', async () => {
  await startDraft('Edited during discard', h.owner.id);
  const host = await hostFor('draft');
  let edit: Promise<string> | undefined;
  // The edit is issued the moment the discard starts, after the caller's own
  // unused check: the old code's in-lock check had already passed by then.
  const landEdit = () => {
    edit ??= host
      .execute(
        {
          type: 'defineModel',
          name: 'Pets',
          fields: { name: { type: 'text' } },
        },
        { author: h.owner.id },
      )
      .then(
        () => 'applied',
        () => 'refused',
      );
  };
  for (const name of ['discard', 'discardIfEmpty'] as const) {
    if (typeof host[name] !== 'function') continue;
    const original = host[name].bind(host);
    vi.spyOn(host, name).mockImplementation(() => {
      landEdit();
      return original() as never;
    });
  }
  const discarded = await discardIfUnused();
  expect(await edit).toBe('applied');
  expect(discarded).toBe(false);
  expect((await getDraftSlot())?.name).toBe('Edited during discard');
  expect(
    (await host.draftChain()).versions.map((v) => v.definition),
  ).toHaveLength(1);
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
  await expect(service.start(h.owner, req)).rejects.toThrow(
    /Connect your assistant/,
  );
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
it('applies imported records only through the owner Apply, then removes the file', async () => {
  await service.start(h.owner, await request());
  await worker();
  await end();
  const before = await (await AppImportCollection.create({ db: h.db })).list();
  const file = join(h.dir, 'imports', `${before[0].id}.xlsx`);
  await runAs(h.owner, () => changesState());
  await flushChecks(); // the debounced exact checks pin the digest
  const state = await runAs(h.owner, () => changesState());
  expect(Object.keys((await getHost()).describe().models)).toEqual([]);
  const result = await runAs(h.owner, () => applyOwnBatch(state.digest));
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
it('records the import as cards by table and keeps the review through a Remove and Put back', async () => {
  await service.start(h.owner, await request());
  await worker();
  await end();
  await runAs(h.owner, () => changesState());
  await flushChecks();
  const state = await runAs(h.owner, () => changesState());
  expect(state.cards.every((c) => c.source === 'import')).toBe(true);
  expect(new Set(state.cards.map((c) => c.group)).size).toBe(1);
  expect(state.cards.some((c) => /^Orders: new table/.test(c.summary))).toBe(
    true,
  );
  const orders = state.cards.find((c) => /^Orders:/.test(c.summary))!;
  await runAs(h.owner, () => removeChangeCard(orders.id));
  // The copy has a new id after the rebuild; the import's review follows it.
  const after = await service.current(h.owner);
  expect(after?.status).toBe('review');
  expect(after?.draftId).toBe((await getDraftSlot())?.id);
  await runAs(h.owner, () => restoreChangeCard(orders.id));
  expect((await service.current(h.owner))?.draftId).toBe(
    (await getDraftSlot())?.id,
  );
  await runAs(h.owner, () => changesState());
  await flushChecks();
  const ready = await runAs(h.owner, () => changesState());
  expect(ready.canApply).toBe(true);
  await runAs(h.owner, () => applyOwnBatch(ready.digest));
  await until(
    async () => (await service.current(h.owner))?.status === 'published',
  );
  expect(await (await getHost()).countRows(importModelName('orders'))).toBe(2);
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

it('repairs malformed multiplication with the exact grammar and records its diagnostic without source fragments', async () => {
  answer = (index) => {
    const plan = businessWorkbook().plan;
    if (!index)
      plan.tables[0].fields[3].calculated = {
        op: 'mul',
        args: [{ col: 'price' }, { col: 'quantity' }],
      } as never;
    return plan;
  };
  const started = await service.start(h.owner, await request());
  await worker();
  expect((await end()).state).toBe('done');
  expect(calls).toBe(2);
  expect(texts[1]).toContain('invalid-expression');
  expect(texts[1]).toContain('tables[0].fields[3].calculated');
  expect(texts[1]).toContain('left');
  expect(texts[1]).toContain('args');
  expect(texts[1]).toContain('not args or symbols');
  const checks = (await getRunTrajectory(h.db, started.id))!.entries
    .map((e) => e.event)
    .filter((e) => e?.type === 'check');
  expect(checks[0]?.payload).toMatchObject({
    diagnostics: [
      { code: 'invalid-expression', path: 'tables[0].fields[3].calculated' },
    ],
  });
  expect(JSON.stringify(checks[0]?.payload)).not.toContain('fragment');
});

it('imports unrepresentable formulas as cached values and lists them for review', async () => {
  const { workbook, plan } = businessWorkbook();
  const total = plan.tables[0].fields[3];
  delete total.calculated;
  delete total.cachedColumn;
  total.column = 4;
  workbook.sheets[1].cells.get(4, 4)!.formula!.text =
    'SUMIF(A4:A5,"Ada",B4:B5)';
  answer = () => plan;
  const bytes = await (await getSpreadsheets({ type: 'xlsx' })).write(workbook);
  await service.start(
    h.owner,
    new Request('http://shell/api/shell/import', {
      method: 'POST',
      body: bytes as BodyInit,
    }),
  );
  await worker();
  const current = await end();
  expect(current).toMatchObject({
    state: 'done',
    proof: { ok: true },
    untranslatedFormulas: [
      {
        sheet: 'Orders',
        field: 'total',
        column: 4,
        count: 2,
        examples: [
          { cell: 'D4', formula: 'SUMIF(A4:A5,"Ada",B4:B5)' },
          { cell: 'D5', formula: 'B5*C5' },
        ],
      },
    ],
  });
  expect(
    await (await hostFor('draft')).countRows(importModelName('orders')),
  ).toBe(2);
});

it('keeps a late Stop on a completed proven import reviewable, including stale paused status after restart', async () => {
  await service.start(h.owner, await request());
  await worker();
  expect((await end()).status).toBe('review');
  await service.action(h.owner, 'stop');
  expect(await service.current(h.owner)).toMatchObject({
    state: 'done',
    status: 'review',
  });
  const [row] = await (await AppImportCollection.create({ db: h.db })).list();
  row.status = 'paused';
  await row.save();
  for (const runner of runners) await runner.stop();
  service.dispose();
  await closeHost();
  configureShell({ db: async () => h.db, dataRoot: async () => h.dir });
  service = install();
  await service.recover();
  expect(await service.current(h.owner)).toMatchObject({
    state: 'done',
    status: 'review',
    step: 'review',
  });
  expect((await draftInfo())?.publishable).toBe(true);
});
it('keeps a late Cancel on a completed import ready for review until an explicit discard', async () => {
  await service.start(h.owner, await request());
  await worker();
  await end();
  await service.action(h.owner, 'cancel');
  expect(await service.current(h.owner)).toMatchObject({
    state: 'done',
    status: 'review',
  });
  expect((await draftInfo())?.publishable).toBe(true);
  await service.action(h.owner, 'discard');
  expect((await service.current(h.owner))?.status).toBe('discarded');
  expect(await getDraftSlot()).toBeNull();
});
it('uses the authoritative result when completion races a Stop request', async () => {
  answer = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return businessWorkbook().plan;
  };
  await service.start(h.owner, await request());
  await worker();
  await until(async () => !!release);
  let finishStop: (() => void) | undefined;
  const actual = service.kit.forOwner.bind(service.kit);
  vi.spyOn(service.kit, 'forOwner').mockImplementation((...args) => {
    const api = actual(...args);
    return {
      ...api,
      stop: async (id: string) => {
        await new Promise<void>((resolve) => {
          finishStop = resolve;
        });
        return api.stop(id);
      },
    };
  });
  const stopping = service.action(h.owner, 'stop');
  try {
    await until(async () => !!finishStop);
    const [waiting] = await (
      await AppImportCollection.create({ db: h.db })
    ).list();
    expect(waiting.status).not.toBe('paused');
    release?.();
    expect((await end()).state).toBe('done');
  } finally {
    finishStop?.();
  }
  await stopping;
  expect(await service.current(h.owner)).toMatchObject({
    state: 'done',
    status: 'review',
  });
  expect((await draftInfo())?.publishable).toBe(true);
});

it.each([
  'before admission',
  'after admission',
  'tracking disabled',
] as const)('rolls back a retry that fails %s and keeps recovery controls usable', async (failure) => {
  answer = () => {
    throw new Error('test engine unavailable');
  };
  const first = await service.start(h.owner, await request());
  await worker();
  await end();
  for (const runner of runners) await runner.stop();
  const actual = service.kit.forOwner.bind(service.kit);
  const fault = vi
    .spyOn(service.kit, 'forOwner')
    .mockImplementation((...args) => {
      const api = actual(...args);
      return {
        ...api,
        retry: async (...retryArgs: Parameters<typeof api.retry>) => {
          if (failure === 'after admission') await api.retry(...retryArgs);
          if (failure === 'tracking disabled') {
            config({ usage: { enabled: true, persist: false } });
            return api.retry(...retryArgs);
          }
          throw new Error('private admission failure');
        },
      };
    });
  await expect(service.action(h.owner, 'retry')).rejects.toMatchObject({
    status: 409,
  });
  fault.mockRestore();
  config({ usage: { enabled: true, persist: true } });
  const [row] = await (await AppImportCollection.create({ db: h.db })).list();
  expect(row).toMatchObject({
    runId: first.id,
    status: 'failed',
    stage: 'failed',
  });
  expect(JSON.parse(row.detail).retry).toBeUndefined();
  const abandoned = (
    await h.db.query(
      'SELECT status FROM _smrt_ai_runs WHERE retry_of_run_id = ?',
      first.id,
    )
  ).rows;
  expect(abandoned.every((run) => run.status === 'cancelled')).toBe(true);
  expect(await service.current(h.owner)).toMatchObject({
    state: 'failed',
    reason: 'engine',
  });
  expect((await service.current(h.owner))?.note).not.toContain('private');
  await expect(service.action(h.owner, 'stop')).resolves.toEqual({ ok: true });
  answer = () => businessWorkbook().plan;
  await service.action(h.owner, 'retry');
  await worker();
  expect((await end()).status).toBe('review');
  expect(await (await hostFor('draft')).countRows('Orders')).toBe(2);
  await service.action(h.owner, 'discard');
});
it.each([
  'stop',
  'cancel',
  'discard',
])('keeps %s usable when the import run is missing', async (action) => {
  await service.start(h.owner, await request());
  const [row] = await (await AppImportCollection.create({ db: h.db })).list();
  row.runId = '00000000-0000-4000-8000-000000000000';
  await row.save();
  await expect(service.action(h.owner, action)).resolves.toEqual({ ok: true });
  const current = await service.current(h.owner);
  expect(current?.status).toBe(
    action === 'stop'
      ? 'failed'
      : action === 'cancel'
        ? 'cancelled'
        : 'discarded',
  );
});

it('recovers a completed proven draft even when an old recovery saved a failed status', async () => {
  await service.start(h.owner, await request());
  await worker();
  await end();
  const [row] = await (await AppImportCollection.create({ db: h.db })).list();
  row.status = 'failed';
  row.detail = JSON.stringify({ ...JSON.parse(row.detail), reason: 'app' });
  await row.save();
  await service.recover();
  expect(await service.current(h.owner)).toMatchObject({
    state: 'done',
    status: 'review',
  });
  expect((await draftInfo())?.publishable).toBe(true);
});

it('isolates an ordinary workflow lookup error to its import without logging details', async () => {
  await service.start(h.owner, await request());
  const actual = service.kit.forOwner.bind(service.kit);
  const fault = vi
    .spyOn(service.kit, 'forOwner')
    .mockImplementation((...args) => ({
      ...actual(...args),
      get: async () => {
        throw new Error('private workflow lookup failure');
      },
    }));
  const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    await expect(service.recover()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      'A workbook import could not be recovered.\n',
    );
    expect(warning.mock.calls.flat().join(' ')).not.toContain(
      'private workflow',
    );
  } finally {
    fault.mockRestore();
    warning.mockRestore();
  }
  expect(await service.current(h.owner)).toMatchObject({
    status: 'failed',
    reason: 'app',
  });
  await expect(service.action(h.owner, 'discard')).resolves.toEqual({
    ok: true,
  });
});
