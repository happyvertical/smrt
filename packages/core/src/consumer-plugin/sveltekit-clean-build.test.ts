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

  it.each([
    ['default config', {}, 'src/lib/server/smrt.ts'],
    [
      'custom config file name',
      { configFileName: 'custom.ts' },
      'src/lib/server/custom.ts',
    ],
    [
      'custom non-lib config path',
      { configPath: 'src/server/runtime', configFileName: 'registry.ts' },
      'src/server/runtime/registry.ts',
    ],
    [
      'separate consumer route root',
      { routesDir: 'src/routes/external' },
      'src/lib/server/smrt.ts',
    ],
  ])(
    'inventories only an explicitly selected provider-qualified route on the first build (%s)',
    async (_configCase, configOverrides, expectedConfigFile) => {
      // SvelteKit deliberately overrides Vite's configured root with the launch
      // cwd. Use a distinct requested Vite root to prove early SMRT generation
      // follows that final SvelteKit root when projectRoot is omitted.
      const configuredViteRoot = join(projectRoot, 'configured-vite-root');
      mkdirSync(configuredViteRoot, { recursive: true });
      mkdirSync(join(projectRoot, 'src/routes'), { recursive: true });
      mkdirSync(join(projectRoot, 'src/lib/objects'), { recursive: true });
      const providerDir = join(projectRoot, 'node_modules', '@acme', 'widgets');
      mkdirSync(join(providerDir, 'dist'), { recursive: true });
      writeFileSync(
        join(projectRoot, 'package.json'),
        JSON.stringify({
          name: '@test/consumer-clean-build',
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
        join(projectRoot, 'src/lib/objects/LocalWidget.ts'),
        [
          "import { SmrtObject, smrt } from '@happyvertical/smrt-core';",
          "@smrt({ api: { include: ['list', 'get'] } })",
          'export class LocalWidget extends SmrtObject {}',
        ].join('\n'),
      );
      writeFileSync(
        join(providerDir, 'package.json'),
        JSON.stringify({
          name: '@acme/widgets',
          version: '1.0.0',
          exports: { '.': './dist/index.js', './objects': './dist/objects.js' },
        }),
      );
      writeFileSync(
        join(providerDir, 'dist/index.js'),
        'export class Widget {}\nexport class Hidden {}\n',
      );
      writeFileSync(
        join(providerDir, 'dist/objects.js'),
        "export { Widget as PublishedWidget } from './index.js';\nexport { Hidden } from './index.js';\n",
      );
      writeFileSync(
        join(providerDir, 'dist/manifest.json'),
        JSON.stringify({
          packageName: '@acme/widgets',
          objects: {
            '@acme/widgets:Widget': {
              className: 'Widget',
              qualifiedName: '@acme/widgets:Widget',
              exportName: 'PublishedWidget',
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
      const producerPluginUrl = pathToFileURL(
        resolve(import.meta.dirname, '../vite-plugin/index.ts'),
      ).href;
      const svelteKitOptions = {
        objects: ['@acme/widgets:Widget'],
        changesRoute: { enabled: true },
        eventsRoute: { enabled: true },
        resourcesRoute: { enabled: false },
        ...configOverrides,
      };
      const consumerRoutesDir = svelteKitOptions.routesDir ?? 'src/routes/api';
      const producerSvelteKitOptions = {
        enabled: true,
        routesDir:
          _configCase === 'separate consumer route root'
            ? 'src/routes/api'
            : consumerRoutesDir,
        objectsDir: 'src/lib/objects',
        configPath: svelteKitOptions.configPath ?? 'src/lib/server',
        configFileName: svelteKitOptions.configFileName ?? 'smrt.ts',
        kebabRoutes: svelteKitOptions.kebabRoutes ?? false,
        changesRoute: { enabled: false },
        eventsRoute: { enabled: false },
        resourcesRoute: { enabled: false },
      };
      writeFileSync(
        join(projectRoot, 'vite.config.ts'),
        `import { sveltekit } from '@sveltejs/kit/vite';
import { smrtConsumer } from ${JSON.stringify(consumerPluginUrl)};
import { smrtPlugin } from ${JSON.stringify(producerPluginUrl)};
import { defineConfig } from 'vite';

export default defineConfig({
  root: ${JSON.stringify(configuredViteRoot)},
  resolve: { alias: { '@happyvertical/smrt-core': ${JSON.stringify(coreUrl)} } },
  plugins: [
    sveltekit(),
    smrtConsumer({
      packages: ['@acme/widgets'],
      disableScanning: true,
      generateTypes: false,
      svelteKit: ${JSON.stringify(svelteKitOptions, null, 2)},
    }),
    smrtPlugin({
      projectRoot: ${JSON.stringify(projectRoot)},
      include: ['src/lib/objects/**/*.ts'],
      generateTypes: false,
      svelteKit: ${JSON.stringify(producerSvelteKitOptions, null, 2)},
    }),
  ],
});
`,
      );

      const viteCli = resolve(
        import.meta.dirname,
        '../../../../node_modules/vite/bin/vite.js',
      );
      await execFileAsync(
        process.execPath,
        [viteCli, 'build', '--config', join(projectRoot, 'vite.config.ts')],
        {
          cwd: projectRoot,
          maxBuffer: 32 * 1024 * 1024,
          timeout: 110_000,
        },
      );

      const itemRoute = join(
        projectRoot,
        consumerRoutesDir,
        'widgets/[id]/+server.ts',
      );
      expect(existsSync(itemRoute)).toBe(true);
      expect(
        existsSync(
          join(projectRoot, 'src/routes/api/localwidgets/[id]/+server.ts'),
        ),
      ).toBe(true);
      expect(
        existsSync(join(projectRoot, consumerRoutesDir, 'hidden/+server.ts')),
      ).toBe(false);
      expect(readFileSync(itemRoute, 'utf8')).toContain(
        "'@acme/widgets:Widget'",
      );
      expect(readFileSync(itemRoute, 'utf8')).toContain(
        "from '@acme/widgets/objects'",
      );
      expect(
        readFileSync(
          join(
            projectRoot,
            expectedConfigFile.replace(/[^/]+$/, 'smrt-register.ts'),
          ),
          'utf8',
        ),
      ).toContain(
        "import { PublishedWidget as Widget } from '@acme/widgets/objects';",
      );
      expect(existsSync(join(projectRoot, expectedConfigFile))).toBe(true);
      expect(existsSync(join(projectRoot, '.smrt/register.js'))).toBe(true);
      expect(existsSync(join(configuredViteRoot, '.smrt/register.js'))).toBe(
        false,
      );
      expect(
        readFileSync(
          join(projectRoot, '.svelte-kit/output/server/manifest-full.js'),
          'utf8',
        ),
      ).toContain(
        `${consumerRoutesDir.replace('src/routes', '')}/widgets/[id]`,
      );
      expect(
        readFileSync(
          join(projectRoot, '.svelte-kit/output/server/manifest-full.js'),
          'utf8',
        ),
      ).toContain('/api/localwidgets/[id]');
    },
    120_000,
  );
});
