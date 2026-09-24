/**
 * #3109 / #3110: consumer classes registered from a plain Node process.
 *
 * Migration scripts and `node --test` suites run consumer models under
 * tsx or `node --enable-source-maps` — no Vite, no test manifests. There,
 * installed smrt-core's stack frames report their source-mapped
 * `node_modules/@happyvertical/smrt-core/src/...` paths. On 0.51.25 the stack
 * walk did not recognize those frames as core's, so every class registered as
 * `@happyvertical/smrt-core:<Name>`: anytown's `db:migrate` failed with
 * `Class '@anytown/dashboard:Network' is not registered`, and ergot's pnpm
 * peer-variant copies of smrt-jobs threw a `SmrtJob` class-name collision.
 *
 * The test installs this package's built dist into a consumer workspace on
 * disk (as a package manager would, not symlinked into the monorepo, so the
 * frames carry the installed path) and runs a consumer script in a child
 * process with source maps enabled.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ConsumerWorkspace,
  createConsumerWorkspace,
  manifestEntry,
} from './helpers/consumer-workspace.js';

const packageDir = resolve(import.meta.dirname, '../../..');
const distDir = resolve(packageDir, 'dist');

interface Report {
  network: string | undefined;
  jobs: (string | undefined)[];
}

describe('#3109: consumer classes under plain Node with source maps', () => {
  let ws: ConsumerWorkspace;

  beforeAll(() => {
    ws = createConsumerWorkspace('smrt-3109-node');
    const installed = ws.path('node_modules/@happyvertical/smrt-core');
    cpSync(resolve(packageDir, 'package.json'), `${installed}/package.json`);
    cpSync(distDir, `${installed}/dist`, {
      recursive: true,
      filter: (source) => !source.endsWith('.d.ts'),
    });
    // Resolve smrt-core's own dependencies from this workspace's install.
    symlinkSync(
      resolve(packageDir, 'node_modules'),
      `${installed}/node_modules`,
    );

    ws.writePackage('apps/app', '@fixture/app');
    ws.write(
      'apps/app/.smrt/manifest.json',
      JSON.stringify({
        version: '1',
        timestamp: 0,
        packageName: '@fixture/app',
        objects: {
          '@fixture/app:Network': manifestEntry({
            className: 'Network',
            packageName: '@fixture/app',
            filePath: 'apps/app/src/models/Network.js',
            tableName: 'networks',
            fields: { githubOrg: { type: 'text' } },
          }),
        },
      }),
    );
    ws.writeModel('apps/app/src/models/Network.js', 'Network');
    for (const variant of ['a', 'b']) {
      const dir = `node_modules/.pnpm/@fixture+jobs@1.0.0_${variant}/node_modules/@fixture/jobs`;
      ws.writePackage(dir, '@fixture/jobs');
      ws.writeModel(`${dir}/dist/index.js`, 'FixtureJob');
    }
    ws.write(
      'apps/app/scripts/report.mjs',
      `
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ObjectRegistry, SmrtObject, smrt } from '@happyvertical/smrt-core';

const root = ${JSON.stringify(ws.root)};
const load = async (relativePath) =>
  (await import(pathToFileURL(resolve(root, relativePath)).href)).define({ smrt, SmrtObject });
const entry = (ctor) => ObjectRegistry.getClassByConstructor(ctor);

const Network = await load('apps/app/src/models/Network.js');
const jobs = [];
for (const variant of ['a', 'b']) {
  jobs.push(await load('node_modules/.pnpm/@fixture+jobs@1.0.0_' + variant + '/node_modules/@fixture/jobs/dist/index.js'));
}
console.log(JSON.stringify({
  network: entry(Network)?.qualifiedName,
  jobs: jobs.map((job) => entry(job)?.qualifiedName),
}));
`,
    );
  });

  afterAll(() => ws?.dispose());

  it('registers each class under its own package, without collisions', () => {
    const script = ws.path('apps/app/scripts/report.mjs');
    const result = spawnSync(
      process.execPath,
      ['--enable-source-maps', script],
      {
        cwd: dirname(dirname(script)),
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, VITEST: '', NODE_ENV: 'development' },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(
      result.stdout.trim().split('\n').pop() ?? '{}',
    ) as Report;

    expect(report.network).toBe('@fixture/app:Network');
    expect(report.jobs).toEqual([
      '@fixture/jobs:FixtureJob',
      '@fixture/jobs:FixtureJob',
    ]);
  });
});
