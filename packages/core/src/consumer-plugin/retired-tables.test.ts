/**
 * The app's merged manifest and declared table retirements (#5005 R3, R11):
 * the consumed packages' entries are checked on load, each keeps its own
 * package, and the list is rebuilt from the current dependencies so a package
 * the app no longer depends on drops out.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { smrtConsumer } from './index';

function buildStart(plugin: Plugin): Promise<void> {
  const hook = plugin.buildStart;
  if (!hook) throw new Error('Expected buildStart hook');
  const handler = typeof hook === 'function' ? hook : hook.handler;
  return Promise.resolve(
    handler.call(
      {} as ThisParameterType<typeof handler>,
      {} as Parameters<typeof handler>[0],
    ),
  );
}

const definitions = [
  {
    release: '1.2.2',
    columns: { id: { type: 'UUID', referenceKind: 'id' } },
  },
];
const entry = (packageName: string, table: string, extra = {}) => ({
  table,
  lastOwner: `${packageName}:Gone`,
  since: '1.2.3',
  reason: 'Folded into another table.',
  rows: 'discard',
  definitions,
  packageName,
  ...extra,
});

describe('smrtConsumer carries checked retirements (#5005)', () => {
  let tmpDir: string;
  const providerManifest = (retiredTables: unknown[]) =>
    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'pkg', 'dist', 'manifest.json'),
      JSON.stringify({ packageName: '@test/pkg', objects: {}, retiredTables }),
    );
  const merged = () =>
    JSON.parse(readFileSync(join(tmpDir, '.smrt', 'manifest.json'), 'utf-8'));
  const plugin = () =>
    smrtConsumer({
      packages: ['@test/pkg'],
      projectRoot: tmpDir,
      disableScanning: true,
      generateTypes: false,
    });

  beforeEach(() => {
    tmpDir = resolve(import.meta.dirname, `__test-retired-${Date.now()}`);
    mkdirSync(join(tmpDir, 'node_modules', '@test', 'pkg', 'dist'), {
      recursive: true,
    });
    mkdirSync(join(tmpDir, '.smrt'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: '@fixture/app', version: '1.0.0' }),
    );
    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'pkg', 'package.json'),
      JSON.stringify({
        name: '@test/pkg',
        version: '1.2.3',
        exports: { '.': './dist/index.js' },
      }),
    );
    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'pkg', 'dist', 'index.js'),
      'export {};\n',
    );
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps each package its own entries and drops a package no longer depended on', async () => {
    providerManifest([entry('@test/pkg', 'pkg_old')]);
    // Left in the file by an earlier build: the app's own, and one of a
    // package the app no longer depends on.
    writeFileSync(
      join(tmpDir, '.smrt', 'manifest.json'),
      JSON.stringify({
        packageName: '@fixture/app',
        objects: {},
        smrtDependencies: ['@gone/pkg'],
        retiredTables: [
          entry('@fixture/app', 'app_old'),
          entry('@gone/pkg', 'gone_old'),
        ],
      }),
    );

    await buildStart(plugin());

    const tables = merged().retiredTables.map(
      (item: { table: string; packageName: string }) =>
        `${item.packageName}:${item.table}`,
    );
    expect(tables).toEqual(['@fixture/app:app_old', '@test/pkg:pkg_old']);
  });

  it.each([
    [
      'an entry labelled with another package',
      entry('@other/pkg', 'pkg_forged'),
      /labelled @other\/pkg/,
    ],
    [
      'a lastOwner outside the package',
      entry('@test/pkg', 'pkg_forged', { lastOwner: '@other/pkg:Gone' }),
      /belongs to another package/,
    ],
    [
      'an entry without definitions',
      entry('@test/pkg', 'pkg_forged', { definitions: undefined }),
      /"definitions"/,
    ],
    [
      'an app package retiring a smrt table',
      entry('@test/pkg', '_smrt_jobs'),
      /only smrt's own packages/,
    ],
  ])('refuses %s in a consumed manifest', async (_name, bad, message) => {
    providerManifest([bad]);
    await expect(buildStart(plugin())).rejects.toThrow(message);
  });
});
