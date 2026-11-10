import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { build } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { smrtConsumer } from './index.js';

const PACKAGE = '@happyvertical/smrt-peer-fixture';

describe('consumer Svelte barrels across installed peer contexts (#4318)', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(import.meta.dirname, '__test-peer-context-'));
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: '@fixture/peer-consumer', type: 'module' }),
    );
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function writePackage(root: string, name: string, label: string) {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        type: 'module',
        exports: {
          '.': './dist/server.js',
          './svelte': {
            svelte: './dist/svelte.js',
            import: './dist/svelte.js',
          },
          './server': './dist/server.js',
          './manifest.json': './dist/manifest.json',
        },
        ...(name === '@test/provider'
          ? { dependencies: { [PACKAGE]: '1.0.0' } }
          : {}),
      }),
    );
    writeFileSync(
      join(root, 'dist/manifest.json'),
      JSON.stringify({ packageName: name, objects: {} }),
    );
    writeFileSync(
      join(root, 'dist/server.js'),
      `import { basename } from 'node:path'; export const marker = basename('/${label}-server');`,
    );
    writeFileSync(
      join(root, 'dist/svelte.js'),
      "export { default } from './Widget.svelte';",
    );
    writeFileSync(join(root, 'dist/Widget.svelte'), `<p>${label}</p>`);
  }

  it('compiles the transitive importer instance without externalizing its JavaScript Svelte barrel', async () => {
    const direct = join(
      directory,
      'node_modules/.pnpm/peer@1.0.0_app/node_modules',
      PACKAGE,
    );
    const provider = join(directory, 'node_modules/@test/provider');
    const nested = join(
      directory,
      'node_modules/.pnpm/peer@1.0.0_provider/node_modules',
      PACKAGE,
    );
    writePackage(direct, PACKAGE, 'app-peer');
    writePackage(provider, '@test/provider', 'provider');
    writePackage(nested, PACKAGE, 'nested-peer');
    mkdirSync(join(directory, 'node_modules/@happyvertical'), {
      recursive: true,
    });
    mkdirSync(join(provider, 'node_modules/@happyvertical'), {
      recursive: true,
    });
    symlinkSync(direct, join(directory, 'node_modules', PACKAGE), 'dir');
    symlinkSync(nested, join(provider, 'node_modules', PACKAGE), 'dir');
    writeFileSync(
      join(provider, 'dist/svelte.js'),
      `export { default } from '${PACKAGE}/svelte';`,
    );
    mkdirSync(join(directory, 'src'));
    writeFileSync(
      join(directory, 'src/entry.js'),
      `
      import Direct from '${PACKAGE}/svelte';
      import Nested from '@test/provider/svelte';
      import { marker } from '${PACKAGE}/server';
      import { render } from 'svelte/server';
      console.log(JSON.stringify({ direct: render(Direct).body, nested: render(Nested).body, marker }));
    `,
    );
    await build({
      root: directory,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        svelte(),
        smrtConsumer({
          packages: ['@test/provider', PACKAGE],
          projectRoot: directory,
          disableScanning: true,
          generateTypes: false,
        }),
      ],
      build: {
        ssr: join(directory, 'src/entry.js'),
        outDir: join(directory, 'server'),
        emptyOutDir: true,
        rollupOptions: { output: { entryFileNames: 'entry.mjs' } },
      },
    });
    const entry = join(directory, 'server/entry.mjs');
    const source = readFileSync(entry, 'utf8');
    const result = spawnSync(process.execPath, [entry], {
      cwd: directory,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      direct: expect.stringContaining('app-peer'),
      nested: expect.stringContaining('nested-peer'),
      marker: 'app-peer-server',
    });
    expect(source).toMatch(
      /from ["']@happyvertical\/smrt-peer-fixture\/server["']/,
    );
    expect(source).not.toMatch(
      /from ["']@happyvertical\/smrt-peer-fixture\/svelte["']/,
    );
  });
});
