import { execFile } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('consumer SvelteKit clean virtual declarations (#2854)', () => {
  const projectRoot = resolve(
    import.meta.dirname,
    `__test-consumer-sveltekit-clean-types-${process.pid}`,
  );

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('generates virtual-module declarations before a clean SvelteKit sync and typecheck', async () => {
    const providerDir = join(projectRoot, 'node_modules', '@acme', 'widgets');
    mkdirSync(join(projectRoot, 'src/routes'), { recursive: true });
    mkdirSync(join(providerDir, 'dist'), { recursive: true });

    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: '@test/consumer-clean-types',
        private: true,
        type: 'module',
      }),
    );
    writeFileSync(
      join(projectRoot, 'svelte.config.js'),
      'export default {};\n',
    );
    writeFileSync(
      join(projectRoot, 'tsconfig.json'),
      JSON.stringify({
        extends: './.svelte-kit/tsconfig.json',
        compilerOptions: { skipLibCheck: true },
      }),
    );
    writeFileSync(
      join(projectRoot, 'src/app.html'),
      '<!doctype html><html><head>%sveltekit.head%</head><body><div style="display: contents">%sveltekit.body%</div></body></html>',
    );
    writeFileSync(
      join(projectRoot, 'src/routes/+page.ts'),
      `import manifest from '@smrt/manifest';
import createClient from '@smrt/client';
import { collectionDefinitions } from '@smrt/web';

export const load = () => ({
  manifestVersion: manifest.version,
  client: createClient(),
  collections: collectionDefinitions,
});
`,
    );
    writeFileSync(
      join(providerDir, 'package.json'),
      JSON.stringify({
        name: '@acme/widgets',
        version: '1.0.0',
        exports: { '.': './dist/index.js' },
      }),
    );
    writeFileSync(
      join(providerDir, 'dist/index.js'),
      'export class Widget {}\n',
    );
    writeFileSync(
      join(providerDir, 'dist/manifest.json'),
      JSON.stringify({
        packageName: '@acme/widgets',
        objects: {
          '@acme/widgets:Widget': {
            className: 'Widget',
            qualifiedName: '@acme/widgets:Widget',
            collection: 'widgets',
            fields: {},
            methods: {},
            decoratorConfig: { api: false },
          },
        },
      }),
    );

    const corePackageRoot = resolve(import.meta.dirname, '../..');
    mkdirSync(join(projectRoot, 'node_modules', '@happyvertical'), {
      recursive: true,
    });
    symlinkSync(
      corePackageRoot,
      join(projectRoot, 'node_modules', '@happyvertical', 'smrt-core'),
      'dir',
    );
    writeFileSync(
      join(projectRoot, 'vite.config.ts'),
      `import { sveltekit } from '@sveltejs/kit/vite';
import { smrtConsumer } from '@happyvertical/smrt-core/consumer-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    smrtConsumer({
      projectRoot: ${JSON.stringify(projectRoot)},
      packages: ['@acme/widgets'],
      disableScanning: true,
      svelteKit: { objects: ['@acme/widgets:Widget'] },
    }),
    sveltekit(),
  ],
});
`,
    );

    const svelteKitCli = resolve(
      import.meta.dirname,
      '../../node_modules/@sveltejs/kit/svelte-kit.js',
    );
    const svelteCheckCli = resolve(
      import.meta.dirname,
      '../../node_modules/.bin/svelte-check',
    );

    await execFileAsync(process.execPath, [svelteKitCli, 'sync'], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 110_000,
    });
    try {
      await execFileAsync(svelteCheckCli, ['--tsconfig', './tsconfig.json'], {
        cwd: projectRoot,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 110_000,
      });
    } catch (error) {
      const failure = error as { stderr?: string; stdout?: string };
      throw new Error(
        `Clean SvelteKit typecheck failed:\n${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      );
    }

    for (const declaration of [
      'smrt-manifest.d.ts',
      'smrt-client.d.ts',
      'smrt-web.d.ts',
    ]) {
      expect(
        readFileSync(
          join(projectRoot, 'src/types/smrt-generated', declaration),
          'utf8',
        ),
      ).toContain("declare module '@smrt/");
    }
    expect(
      readFileSync(
        join(projectRoot, 'src/types/smrt-generated/smrt-objects.d.ts'),
        'utf8',
      ),
    ).toContain('export interface WidgetData');
  }, 120_000);
});
