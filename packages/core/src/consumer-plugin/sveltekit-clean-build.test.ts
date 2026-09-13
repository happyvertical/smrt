import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('consumer SvelteKit route hosting clean build (#2850)', () => {
  const projectRoot = resolve(
    import.meta.dirname,
    `__test-consumer-sveltekit-clean-build-${process.pid}`,
  );

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('inventories only an explicitly selected provider-qualified route on the first build', async () => {
    mkdirSync(join(projectRoot, 'src/routes'), { recursive: true });
    const providerDir = join(projectRoot, 'node_modules', '@acme', 'widgets');
    mkdirSync(join(providerDir, 'dist'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'consumer-clean-build',
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
      JSON.stringify({ extends: './.svelte-kit/tsconfig.json' }),
    );
    writeFileSync(
      join(projectRoot, 'src/app.html'),
      '<!doctype html><html><head>%sveltekit.head%</head><body><div style="display: contents">%sveltekit.body%</div></body></html>',
    );
    writeFileSync(
      join(projectRoot, 'src/routes/+page.svelte'),
      '<h1>fixture</h1>\n',
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
      'export class Widget {}\nexport class Hidden {}\n',
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
            decoratorConfig: { api: { include: ['list', 'get'] } },
          },
          '@acme/widgets:Hidden': {
            className: 'Hidden',
            qualifiedName: '@acme/widgets:Hidden',
            collection: 'hidden',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
        },
      }),
    );

    const consumerPluginUrl = pathToFileURL(
      resolve(import.meta.dirname, 'index.ts'),
    ).href;
    const coreUrl = pathToFileURL(
      resolve(import.meta.dirname, '../index.ts'),
    ).href;
    writeFileSync(
      join(projectRoot, 'vite.config.ts'),
      `import { sveltekit } from '@sveltejs/kit/vite';
import { smrtConsumer } from ${JSON.stringify(consumerPluginUrl)};
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { alias: { '@happyvertical/smrt-core': ${JSON.stringify(coreUrl)} } },
  plugins: [
    sveltekit(),
    smrtConsumer({
      projectRoot: ${JSON.stringify(projectRoot)},
      packages: ['@acme/widgets'],
      disableScanning: true,
      generateTypes: false,
      svelteKit: {
        objects: ['@acme/widgets:Widget'],
        changesRoute: { enabled: false },
        eventsRoute: { enabled: false },
        resourcesRoute: { enabled: false },
      },
    }),
  ],
});
`,
    );

    const viteCli = resolve(
      import.meta.dirname,
      '../../../../node_modules/vite/bin/vite.js',
    );
    await execFileAsync(process.execPath, [viteCli, 'build'], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 110_000,
    });

    const itemRoute = join(
      projectRoot,
      'src/routes/api/widgets/[id]/+server.ts',
    );
    expect(existsSync(itemRoute)).toBe(true);
    expect(
      existsSync(join(projectRoot, 'src/routes/api/hidden/+server.ts')),
    ).toBe(false);
    expect(readFileSync(itemRoute, 'utf8')).toContain("'@acme/widgets:Widget'");
    expect(
      readFileSync(
        join(projectRoot, '.svelte-kit/output/server/manifest-full.js'),
        'utf8',
      ),
    ).toContain('/api/widgets/[id]');
  }, 120_000);
});
