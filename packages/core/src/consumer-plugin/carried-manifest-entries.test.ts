/**
 * `.smrt/manifest.json` carries consumed-package entries from one build to
 * the next. Both writers (`smrtPlugin()`'s local write and `smrtConsumer()`'s
 * aggregated write) keep a carried entry only while it still describes what
 * is installed: its provider is installed, the provider's manifest declares
 * it, and its recorded version is the installed one (#5035).
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retainInstalledCarriedEntries } from '../manifest/installed-package-manifest.js';
import { smrtPlugin } from '../vite-plugin/index.js';
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

const carried = (
  packageName: string,
  className: string,
  packageVersion: string,
) => ({
  className,
  name: className,
  qualifiedName: `${packageName}:${className}`,
  packageName,
  packageVersion,
  collection: `${className.toLowerCase()}s`,
  filePath: '',
  fields: {},
  methods: {},
  decoratorConfig: {},
});

describe('carried consumed-package manifest entries (#5035)', () => {
  let tmpDir: string;
  const providerDir = () => join(tmpDir, 'node_modules', '@test', 'carried');

  function installProvider(version: string, classNames: string[]) {
    mkdirSync(join(providerDir(), 'dist'), { recursive: true });
    writeFileSync(
      join(providerDir(), 'package.json'),
      JSON.stringify({
        name: '@test/carried',
        version,
        exports: {
          '.': './dist/index.js',
          './manifest.json': './dist/manifest.json',
        },
      }),
    );
    writeFileSync(join(providerDir(), 'dist', 'index.js'), 'export {};\n');
    writeFileSync(
      join(providerDir(), 'dist', 'manifest.json'),
      JSON.stringify({
        moduleType: 'smrt',
        version: '1.0.0',
        packageName: '@test/carried',
        objects: Object.fromEntries(
          classNames.map((name) => [
            `@test/carried:${name}`,
            carried('@test/carried', name, version),
          ]),
        ),
      }),
    );
  }

  function writePreviousManifest(objects: Record<string, unknown>) {
    writeFileSync(
      join(tmpDir, '.smrt', 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        timestamp: 0,
        packageName: '@fixture/carried-app',
        objects,
      }),
    );
  }

  const writtenKeys = () =>
    Object.keys(
      JSON.parse(readFileSync(join(tmpDir, '.smrt', 'manifest.json'), 'utf-8'))
        .objects,
    ).sort();

  beforeEach(() => {
    tmpDir = resolve(import.meta.dirname, `__test-carried-${Date.now()}`);
    mkdirSync(join(tmpDir, '.smrt'), { recursive: true });
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: '@fixture/carried-app', version: '1.0.0' }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  const previous = {
    '@fixture/carried-app:Local': carried(
      '@fixture/carried-app',
      'Local',
      '1.0.0',
    ),
    '@test/carried:Kept': carried('@test/carried', 'Kept', '2.0.0'),
    '@test/carried:Removed': carried('@test/carried', 'Removed', '2.0.0'),
    '@gone/pkg:Thing': carried('@gone/pkg', 'Thing', '1.0.0'),
  };

  it('the local manifest write drops entries the installed provider no longer declares', async () => {
    installProvider('2.0.0', ['Kept']);
    writePreviousManifest(previous);

    const plugin = smrtPlugin({
      projectRoot: tmpDir,
      include: ['src/**/*.ts'],
      generateTypes: false,
    });
    await (plugin as any).configResolved({
      root: tmpDir,
      build: {},
      plugins: [{ name: 'smrt-consumer' }],
    });

    // The local scan owns local entries (none here); of the carried ones only
    // the still-declared, same-version entry survives.
    expect(writtenKeys()).toEqual(['@test/carried:Kept']);
  });

  it('the local manifest write drops entries recorded for another installed version', async () => {
    installProvider('3.0.0', ['Kept']);
    writePreviousManifest(previous);

    const plugin = smrtPlugin({
      projectRoot: tmpDir,
      include: ['src/**/*.ts'],
      generateTypes: false,
    });
    await (plugin as any).configResolved({
      root: tmpDir,
      build: {},
      plugins: [{ name: 'smrt-consumer' }],
    });

    expect(writtenKeys()).toEqual([]);
  });

  it('the consumer manifest write drops a removed model of a consumed package', async () => {
    installProvider('2.0.0', ['Kept']);
    writePreviousManifest(previous);

    await buildStart(
      smrtConsumer({
        packages: ['@test/carried'],
        projectRoot: tmpDir,
        disableScanning: true,
        generateTypes: false,
      }) as Plugin,
    );

    expect(writtenKeys()).toEqual([
      '@fixture/carried-app:Local',
      '@test/carried:Kept',
    ]);
  });

  function installExecutableOnlyProvider(classNames: string[]) {
    const dir = join(tmpDir, 'node_modules', '@test', 'legacy');
    mkdirSync(join(dir, 'dist', 'manifest'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@test/legacy',
        version: '2.0.0',
        exports: { '.': './dist/index.js' },
      }),
    );
    writeFileSync(join(dir, 'dist', 'index.js'), 'export {};\n');
    const objects = Object.fromEntries(
      classNames.map((name) => [
        `@test/legacy:${name}`,
        carried('@test/legacy', name, '2.0.0'),
      ]),
    );
    writeFileSync(
      join(dir, 'dist', 'manifest', 'static-manifest.js'),
      `export const staticManifest = ${JSON.stringify({
        moduleType: 'smrt',
        packageName: '@test/legacy',
        objects,
      })};\n`,
    );
  }

  it.each([
    ['still declares another model', ['Kept']],
    ['now declares no models', []],
  ])('drops a removed model of an executable-only provider that %s, and a later producer write keeps it dropped', async (_label, classNames) => {
    installExecutableOnlyProvider(classNames);
    writePreviousManifest({
      '@fixture/carried-app:Local': carried(
        '@fixture/carried-app',
        'Local',
        '1.0.0',
      ),
      '@test/legacy:Kept': carried('@test/legacy', 'Kept', '2.0.0'),
      '@test/legacy:Removed': carried('@test/legacy', 'Removed', '2.0.0'),
    });

    await buildStart(
      smrtConsumer({
        packages: ['@test/legacy'],
        projectRoot: tmpDir,
        disableScanning: true,
        generateTypes: false,
      }) as Plugin,
    );
    const expected = [
      '@fixture/carried-app:Local',
      ...classNames.map((name) => `@test/legacy:${name}`),
    ].sort();
    expect(writtenKeys()).toEqual(expected);

    const producer = smrtPlugin({
      projectRoot: tmpDir,
      include: ['src/**/*.ts'],
      generateTypes: false,
    });
    await (producer as any).configResolved({
      root: tmpDir,
      build: {},
      plugins: [{ name: 'smrt-consumer' }],
    });
    expect(writtenKeys()).not.toContain('@test/legacy:Removed');
  });

  it('keeps carried entries whose provider is installed unchanged', () => {
    installProvider('2.0.0', ['Kept', 'Other']);
    const { retained, dropped } = retainInstalledCarriedEntries(
      {
        '@test/carried:Kept': carried('@test/carried', 'Kept', '2.0.0'),
        '@test/carried:Other': carried('@test/carried', 'Other', '2.0.0'),
      },
      tmpDir,
    );

    expect(Object.keys(retained).sort()).toEqual([
      '@test/carried:Kept',
      '@test/carried:Other',
    ]);
    expect(dropped).toEqual([]);
  });
});
