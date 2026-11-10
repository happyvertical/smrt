import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { smrtConsumer } from './index.js';

const PACKAGE = '@happyvertical/smrt-dev-context-fixture';
const nativeRequire = createRequire(import.meta.url);
let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function fixturePackage(root: string, name: string, label: string) {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      type: 'module',
      exports: {
        '.': './dist/server.js',
        './server': './dist/server.js',
        './svelte': { svelte: './dist/svelte.js', import: './dist/svelte.js' },
        './style.css': './dist/style.css',
        './manifest.json': './dist/manifest.json',
      },
      ...(name === '@test/dev-provider'
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
    'let enabled = false; export function enable() { enabled = true; } export function isEnabled() { return enabled; }',
  );
  writeFileSync(
    join(root, 'dist/svelte.js'),
    "export { default } from './Widget.svelte';",
  );
  writeFileSync(join(root, 'dist/Widget.svelte'), `<p>${label}</p>`);
  writeFileSync(join(root, 'dist/style.css'), 'p { color: red; }');
}

describe('selective consumer SSR dev module identity (#4475)', () => {
  it('shares native initialized server roots/subpaths while compiling importer-local Svelte barrels and CSS', async () => {
    directory = mkdtempSync(join(import.meta.dirname, '__test-dev-context-'));
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: '@fixture/dev-context-consumer', type: 'module' }),
    );
    const direct = join(
      directory,
      'node_modules/.pnpm/context_app/node_modules',
      PACKAGE,
    );
    const nested = join(
      directory,
      'node_modules/.pnpm/context_provider/node_modules',
      PACKAGE,
    );
    const provider = join(directory, 'node_modules/@test/dev-provider');
    fixturePackage(direct, PACKAGE, 'app-context');
    fixturePackage(nested, PACKAGE, 'provider-context');
    fixturePackage(provider, '@test/dev-provider', 'provider');
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
    writeFileSync(
      join(provider, 'dist/server.js'),
      `export { isEnabled } from '${PACKAGE}';`,
    );
    mkdirSync(join(directory, 'src'));
    writeFileSync(
      join(directory, 'src/entry.js'),
      `import { isEnabled } from '${PACKAGE}';
import { isEnabled as subpathEnabled } from '${PACKAGE}/server';
import { isEnabled as nestedEnabled } from '@test/dev-provider';
import Direct from '${PACKAGE}/svelte';
import Nested from '@test/dev-provider/svelte';
import '${PACKAGE}/style.css';
import { render } from 'svelte/server';
export const flags = [isEnabled(), subpathEnabled(), nestedEnabled()];
export const direct = render(Direct).body;
export const nested = render(Nested).body;`,
    );
    // Models and native server initializers run outside Vite before a dev SSR request.
    nativeRequire(join(direct, 'dist/server.js')).enable();
    nativeRequire(join(nested, 'dist/server.js')).enable();
    const server = await createServer({
      root: directory,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        svelte(),
        smrtConsumer({
          packages: ['@test/dev-provider', PACKAGE],
          projectRoot: directory,
          disableScanning: true,
          generateTypes: false,
        }),
      ],
      appType: 'custom',
      server: { middlewareMode: true },
    });
    try {
      const result = await server.ssrLoadModule('/src/entry.js');
      expect(result.flags).toEqual([true, true, true]);
      expect(result.direct).toContain('app-context');
      expect(result.nested).toContain('provider-context');
    } finally {
      await server.close();
    }
  });
});
