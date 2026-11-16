// The shell's own database (shell.db) must pass core's startup check (#4927)
// the normal way: the local runtime migrates it at start and records the stamp
// of the build it runs. This loads the shell's real build stamp (the module
// the generated registration imports) and starts the real local runtime with
// NODE_ENV=production, as the desktop sidecar does.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSmrtSvelteKitRuntime,
  type SmrtSvelteKitRuntime,
} from '@happyvertical/smrt-app-runtime/sveltekit';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import {
  config,
  createTrackedAiClient,
  readLastMigrateRecord,
  registerBuildSchema,
  registeredBuildSchema,
  transitionAiRun,
} from '@happyvertical/smrt-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import './registry.ts';
import '../objects/index.ts';
import { businessBytes } from '../../../test-support/import-workbook.ts';
import { AppDraftCollection } from '../objects/AppDraft.ts';
import { AppImportCollection } from '../objects/AppImport.ts';
import { configureShell, getDraftSlot, resetShell } from './host.ts';
import { createShellImportService } from './import-workflow.ts';
import { setOwnerCheck } from './owner.ts';
import { prepareShellSchema } from './schema.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'shell-prod-start-')));
const sourceRoot = join(root, 'source');
const dataDirectory = join(root, 'data');
const saved = {
  NODE_ENV: process.env.NODE_ENV,
  SMRT_ALLOW_UNMIGRATED_START: process.env.SMRT_ALLOW_UNMIGRATED_START,
};
const open: SmrtSvelteKitRuntime[] = [];

beforeAll(async () => {
  mkdirSync(sourceRoot);
  writeFileSync(
    join(sourceRoot, 'package.json'),
    JSON.stringify({ name: '@acme/shell-prod-start' }),
  );
  // What the generated registration imports first in the built shell.
  // @ts-expect-error generated JavaScript module without types
  await import('../../../.smrt/build-schema.js');
  process.env.NODE_ENV = 'production';
  delete process.env.SMRT_ALLOW_UNMIGRATED_START;
});
afterAll(async () => {
  for (const runtime of open.splice(0)) {
    try {
      await (await runtime.localRuntime()).db.close?.();
    } catch {
      // never started
    }
  }
  registerBuildSchema(undefined);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  const runtime = createSmrtSvelteKitRuntime({
    sourceRoot,
    dataDirectory,
    runtime: resolveApplicationRuntime({ profile: 'local' }),
    env: { NODE_ENV: 'production', HOST: '127.0.0.1' },
    prepareDatabase: async (db) => {
      await prepareShellSchema(db);
    },
    classOverrides: {},
  });
  open.push(runtime);
  await runtime.init();
  await runtime.ready();
  return runtime;
}

it('records the build stamp on the first start and starts again on a restart', async () => {
  const build = registeredBuildSchema();
  expect(build?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  const first = await start();
  const db = (await first.localRuntime()).db;
  const record = await readLastMigrateRecord(db, { engineHint: 'sqlite' });
  expect(record.state).toBe('recorded');
  expect(record.state === 'recorded' ? record.record.fingerprint : null).toBe(
    build?.fingerprint,
  );
  const tables = (
    await db.query("SELECT name FROM sqlite_master WHERE type = 'table'")
  ).rows.map((r) => r.name);
  expect(tables).toEqual(
    expect.arrayContaining([
      'app_imports',
      '_smrt_jobs',
      '_smrt_ai_usage',
      '_smrt_ai_runs',
      '_smrt_ai_run_events',
      '_smrt_ai_run_checkpoints',
    ]),
  );
  await db.close?.();
  open.splice(0);
  await start();
});

it('migrates an existing database left by an older build before it serves', async () => {
  const build = registeredBuildSchema();
  let db = (await open[0].localRuntime()).db;
  // The previous release had no import record table. The normal migration adds it.
  await db.query('DROP TABLE app_imports');
  // The database as the previous release left it: its last migrate recorded
  // another build's stamp. The desktop wrapper runs no migrate of its own.
  await db.query(
    `UPDATE _smrt_migrate_runs SET fingerprint = '${'0'.repeat(64)}'`,
  );
  await db.close?.();
  open.splice(0);
  const upgraded = await start();
  db = (await upgraded.localRuntime()).db;
  expect(
    (
      await db.query(
        "SELECT name FROM sqlite_master WHERE name = 'app_imports'",
      )
    ).rows,
  ).toHaveLength(1);
  const record = await readLastMigrateRecord(db, { engineHint: 'sqlite' });
  expect(record.state === 'recorded' ? record.record.fingerprint : null).toBe(
    build?.fingerprint,
  );
});

it('starts with bad import rows and isolates failed retry admission, missing runs and lost drafts', async () => {
  const initial = open[0] ?? (await start());
  let db = (await initial.localRuntime()).db;
  const owners = Array.from({ length: 3 }, () => ({
    id: randomUUID(),
    tenantId: randomUUID(),
  }));
  const install = () => {
    configureShell({ db: async () => db, dataRoot: async () => dataDirectory });
    setOwnerCheck(async () => true);
    return createShellImportService({
      db,
      root: dataDirectory,
      ready: async () => {},
      tracked: (owner) =>
        createTrackedAiClient({
          db,
          tenantId: owner.tenantId,
          ai: {
            embed: async () => [],
            chat: async () => {
              throw new Error('No model should run during recovery');
            },
          } as never,
        }),
    });
  };
  let imports = install();
  const upload = async () =>
    new Request('http://shell/api/shell/import', {
      method: 'POST',
      body: (await businessBytes()) as BodyInit,
    });
  config({ usage: { enabled: true, persist: true } });
  try {
    const first = await imports.start(owners[0], await upload());
    await transitionAiRun(db, first.id, {
      from: 'running',
      to: 'failed',
      stopReason: 'error',
    });
    let collection = await AppImportCollection.create({ db });
    const [retry] = await collection.list({ where: { ownerId: owners[0].id } });
    const attempt = randomUUID();
    retry.runId = attempt;
    retry.detail = JSON.stringify({
      ...JSON.parse(retry.detail),
      reason: 'engine',
      retry: { from: first.id, id: attempt },
    });
    await retry.save();
    const missing = await collection.create({
      ...owners[1],
      id: randomUUID(),
      ownerId: owners[1].id,
      runId: randomUUID(),
      status: 'running',
    });
    await missing.save();
    const complete = await imports.start(owners[2], await upload());
    await transitionAiRun(db, complete.id, { from: 'running', to: 'done' });
    const [lost] = await collection.list({ where: { ownerId: owners[2].id } });
    lost.draftId = randomUUID();
    lost.status = 'proven';
    const gone = await (await AppDraftCollection.create({ db })).create({
      id: lost.draftId,
      name: 'Imported workbook',
      status: 'open',
      createdBy: owners[2].id,
    });
    await gone.save();
    // The open draft record survives, but its on-disk copy is gone.
    expect(existsSync(join(dataDirectory, 'user-app-draft', 'app.db'))).toBe(
      false,
    );
    lost.detail = JSON.stringify({
      ...JSON.parse(lost.detail),
      proof: { ok: true },
    });
    await lost.save();
    imports.dispose();
    await resetShell();
    await db.close?.();
    open.splice(0);
    config({ usage: { enabled: true, persist: false } });
    const restarted = await start();
    db = (await restarted.localRuntime()).db;
    imports = install();
    await expect(imports.recover()).resolves.toBeUndefined();
    collection = await AppImportCollection.create({ db });
    expect((await collection.get(retry.id as string))?.runId).toBe(first.id);
    for (const owner of owners) {
      expect((await imports.current(owner))?.status).toBe('failed');
      await expect(imports.action(owner, 'discard')).resolves.toEqual({
        ok: true,
      });
    }
    expect(await getDraftSlot()).toBeNull();
    // Import corruption never changes the supported production migration stamp.
    expect(
      (await readLastMigrateRecord(db, { engineHint: 'sqlite' })).state,
    ).toBe('recorded');
    await expect(restarted.ready()).resolves.toBeUndefined();
  } finally {
    imports.dispose();
    config({ usage: { enabled: true, persist: true } });
    setOwnerCheck(null);
    await resetShell();
  }
});
