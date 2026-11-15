// The shell's own database (shell.db) must pass core's startup check (#4927)
// the normal way: the local runtime migrates it at start and records the stamp
// of the build it runs. This loads the shell's real build stamp (the module
// the generated registration imports) and starts the real local runtime with
// NODE_ENV=production, as the desktop sidecar does.
import {
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
  readLastMigrateRecord,
  registerBuildSchema,
  registeredBuildSchema,
} from '@happyvertical/smrt-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import './registry.ts';
import '../objects/index.ts';
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
  await db.close?.();
  open.splice(0);
  await start();
});

it('migrates an existing database left by an older build before it serves', async () => {
  const build = registeredBuildSchema();
  let db = (await open[0].localRuntime()).db;
  // The database as the previous release left it: its last migrate recorded
  // another build's stamp. The desktop wrapper runs no migrate of its own.
  await db.query(
    `UPDATE _smrt_migrate_runs SET fingerprint = '${'0'.repeat(64)}'`,
  );
  await db.close?.();
  open.splice(0);
  const upgraded = await start();
  db = (await upgraded.localRuntime()).db;
  const record = await readLastMigrateRecord(db, { engineHint: 'sqlite' });
  expect(record.state === 'recorded' ? record.record.fingerprint : null).toBe(
    build?.fingerprint,
  );
});
