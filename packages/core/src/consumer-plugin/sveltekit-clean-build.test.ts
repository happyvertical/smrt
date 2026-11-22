import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
      const overrides: {
        routesDir?: string;
        configPath?: string;
        configFileName?: string;
        kebabRoutes?: boolean;
      } = configOverrides;
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
        ...overrides,
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
  // This isolated consumer must not inherit the core package decorator config.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
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
      const svelteKitRegistration = readFileSync(
        join(
          projectRoot,
          expectedConfigFile.replace(/[^/]+$/, 'smrt-register.ts'),
        ),
        'utf8',
      );
      expect(svelteKitRegistration).toContain('LocalWidget');
      expect(svelteKitRegistration).not.toContain('PublishedWidget');
      expect(svelteKitRegistration).toContain('.smrt/register.js');
      expect(existsSync(join(projectRoot, expectedConfigFile))).toBe(true);
      expect(existsSync(join(projectRoot, '.smrt/register.js'))).toBe(true);
      expect(
        readFileSync(join(projectRoot, '.smrt/register.js'), 'utf8'),
      ).toContain("from '@acme/widgets/objects'");
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

  it('removes a disabled hosted child-symlink handler before SvelteKit inventories routes', async () => {
    mkdirSync(join(projectRoot, 'src/lib/server'), { recursive: true });
    mkdirSync(join(projectRoot, 'src/routes'), { recursive: true });
    const providerDir = join(projectRoot, 'node_modules', '@acme', 'widgets');
    mkdirSync(join(providerDir, 'dist'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: '@test/consumer-symlink-revocation',
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
      join(projectRoot, 'src/lib/server/smrt.ts'),
      'export async function getCollection() { return {}; }\n',
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
            decoratorConfig: { api: { include: ['list', 'get'] } },
          },
        },
      }),
    );
    const hostedWidgets = join(projectRoot, 'hosted-widgets');
    mkdirSync(join(projectRoot, 'src/routes/api'), { recursive: true });
    mkdirSync(hostedWidgets, { recursive: true });
    symlinkSync(
      hostedWidgets,
      join(projectRoot, 'src/routes/api/widgets'),
      'dir',
    );

    const consumerPluginUrl = pathToFileURL(
      resolve(import.meta.dirname, 'index.ts'),
    ).href;
    const coreUrl = pathToFileURL(
      resolve(import.meta.dirname, '../index.ts'),
    ).href;
    const viteCli = resolve(
      import.meta.dirname,
      '../../../../node_modules/vite/bin/vite.js',
    );
    const writeViteConfig = (svelteKit: string) =>
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
      svelteKit: ${svelteKit},
    }),
  ],
});
`,
      );

    writeViteConfig("{ objects: ['@acme/widgets:Widget'] }");
    await execFileAsync(process.execPath, [viteCli, 'build'], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 110_000,
    });
    expect(existsSync(join(hostedWidgets, '+server.ts'))).toBe(true);
    expect(
      readFileSync(
        join(projectRoot, '.svelte-kit/output/server/manifest-full.js'),
        'utf8',
      ),
    ).toContain('/api/widgets');

    writeViteConfig('false');
    await execFileAsync(process.execPath, [viteCli, 'build'], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 110_000,
    });
    expect(existsSync(join(hostedWidgets, '+server.ts'))).toBe(false);
    expect(
      readFileSync(
        join(projectRoot, '.svelte-kit/output/server/manifest-full.js'),
        'utf8',
      ),
    ).not.toContain('/api/widgets');
  }, 120_000);
});

describe('plugin-managed knowledge route in a clean build (#5462)', () => {
  const projectRoot = resolve(
    import.meta.dirname,
    `__test-consumer-knowledge-clean-build-${process.pid}`,
  );
  const MARKER = 'knowledge-artifact-marker-5462';

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** A clean producer+consumer SvelteKit app with the knowledge API enabled. */
  function writeFixture(requireAdmin: boolean): string {
    mkdirSync(join(projectRoot, 'src/routes'), { recursive: true });
    mkdirSync(join(projectRoot, 'src/lib/objects'), { recursive: true });
    const providerDir = join(projectRoot, 'node_modules', '@acme', 'widgets');
    mkdirSync(join(providerDir, 'dist'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: '@test/knowledge-clean-build',
        private: true,
        type: 'module',
      }),
    );
    writeFileSync(
      join(projectRoot, 'svelte.config.js'),
      'export default {};\n',
    );
    writeFileSync(
      join(projectRoot, 'smrt.config.json'),
      JSON.stringify({
        knowledge: { summary: MARKER, api: { enabled: true, requireAdmin } },
      }),
    );
    writeFileSync(
      join(projectRoot, 'src/app.html'),
      '<!doctype html><html><head>%sveltekit.head%</head><body><div style="display: contents">%sveltekit.body%</div></body></html>',
    );
    writeFileSync(
      join(projectRoot, 'src/hooks.server.js'),
      [
        'export const handle = async ({ event, resolve }) => {',
        "  if (event.request.headers.get('x-smrt-admin') === '1') {",
        '    event.locals.smrtKnowledgeAdmin = true;',
        '  }',
        '  return resolve(event);',
        '};',
      ].join('\n'),
    );
    // A client component importing the route's keyed module directly.
    const moduleId = `smrt:knowledge-artifact/${createHash('sha256')
      .update(realpathSync.native(projectRoot))
      .digest('hex')
      .slice(0, 16)}`;
    writeFileSync(
      join(projectRoot, 'src/routes/+page.svelte'),
      `<script>\nimport artifact from '${moduleId}';\n</script>\n<p>{artifact === null ? 'none' : 'some'}</p>\n`,
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
            decoratorConfig: { api: { include: ['list', 'get'] } },
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
    writeFileSync(
      join(projectRoot, 'vite.config.ts'),
      `import { sveltekit } from '@sveltejs/kit/vite';
import { smrtConsumer } from ${JSON.stringify(consumerPluginUrl)};
import { smrtPlugin } from ${JSON.stringify(producerPluginUrl)};
import { defineConfig } from 'vite';

export default defineConfig({
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
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
        routesDir: 'src/routes/external',
        changesRoute: { enabled: false },
        eventsRoute: { enabled: false },
        resourcesRoute: { enabled: false },
      },
    }),
    smrtPlugin({
      projectRoot: ${JSON.stringify(projectRoot)},
      include: ['src/lib/objects/**/*.ts'],
      generateTypes: false,
      svelteKit: {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        changesRoute: { enabled: false },
        eventsRoute: { enabled: false },
        resourcesRoute: { enabled: false },
      },
    }),
  ],
});
`,
    );
    return moduleId;
  }

  async function buildFixture(): Promise<void> {
    const viteCli = resolve(
      import.meta.dirname,
      '../../../../node_modules/vite/bin/vite.js',
    );
    await execFileAsync(process.execPath, [viteCli, 'build'], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 170_000,
      // A production build: the route is not in dev mode (the test runner
      // exports NODE_ENV=test).
      env: { ...process.env, NODE_ENV: 'production' },
    });
  }

  /** Request the knowledge endpoint from the built SvelteKit server. */
  async function requestKnowledge(
    admin: boolean,
  ): Promise<{ status: number; body: unknown }> {
    const script = join(projectRoot, 'request-knowledge.mjs');
    writeFileSync(
      script,
      `import { Server } from './.svelte-kit/output/server/index.js';
import { manifest } from './.svelte-kit/output/server/manifest.js';
const server = new Server(manifest);
await server.init({ env: process.env });
const response = await server.respond(
  new Request('http://localhost/__smrt/knowledge', {
    headers: ${admin ? "{ 'x-smrt-admin': '1' }" : '{}'},
  }),
  { getClientAddress: () => '127.0.0.1' },
);
const text = await response.text();
let body = text;
try { body = JSON.parse(text); } catch {}
process.stdout.write(JSON.stringify({ status: response.status, body }));
`,
    );
    const { stdout } = await execFileAsync(process.execPath, [script], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
      env: { ...process.env, NODE_ENV: 'production' },
    });
    return JSON.parse(stdout.slice(stdout.lastIndexOf('{"status"')));
  }

  /** Compare artifacts ignoring generatedAt, sourceHashes and key order. */
  function comparable(value: unknown): unknown {
    const sort = (entry: unknown): unknown => {
      // Build passes may emit the same objects in another order.
      if (Array.isArray(entry)) {
        return entry
          .map(sort)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      if (entry && typeof entry === 'object') {
        return Object.fromEntries(
          Object.entries(entry as Record<string, unknown>)
            .filter(([key]) => key !== 'generatedAt' && key !== 'sourceHashes')
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, nested]) => [key, sort(nested)]),
        );
      }
      return entry;
    };
    return sort(value);
  }

  function clientOutputContains(text: string): boolean {
    const walk = (directory: string): boolean =>
      readdirSync(directory, { withFileTypes: true }).some((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
          ? walk(path)
          : readFileSync(path, 'utf8').includes(text);
      });
    return walk(join(projectRoot, '.svelte-kit/output/client'));
  }

  it('a clean build serves the authorised projection of the final knowledge artifact', async () => {
    writeFixture(true);
    await buildFixture();

    const artifact = JSON.parse(
      readFileSync(join(projectRoot, '.smrt/smrt-knowledge.json'), 'utf8'),
    );
    expect(JSON.stringify(artifact)).toContain('Widget');
    const projection = { ...artifact, prompts: [] };
    delete projection.agentDoc;
    delete projection.moduleDocs;
    const admin = await requestKnowledge(true);
    expect(admin.status).toBe(200);
    expect(comparable(admin.body)).toEqual(comparable(projection));
    expect(JSON.stringify(admin.body)).toContain('@acme/widgets');
    // Production without admin access is refused.
    expect((await requestKnowledge(false)).status).toBe(403);

    // Consumer-only hosting materialised the build-schema module.
    expect(existsSync(join(projectRoot, '.smrt/build-schema.js'))).toBe(true);

    // The knowledge module is empty outside the server environment.
    expect(clientOutputContains(MARKER)).toBe(false);
    expect(JSON.stringify(admin.body)).toContain(MARKER);
  }, 240_000);

  it('a public knowledge route redacts dependency and source metadata', async () => {
    writeFixture(false);
    await buildFixture();
    const response = await requestKnowledge(false);
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body.summary).toBe(MARKER);
    for (const key of [
      'dependencies',
      'sourceHashes',
      'sourceManifestPath',
      'agentDocPath',
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  }, 240_000);
});

describe('consumer-only hosting materialises the build-schema module (#5462)', () => {
  it('with zero packages, the build-schema module exists after the config hook', async () => {
    const root = resolve(
      import.meta.dirname,
      `__test-consumer-zero-packages-${process.pid}`,
    );
    try {
      mkdirSync(root, { recursive: true });
      const { contributeSvelteKitRoutes } = await import(
        '../vite-plugin/sveltekit-route-coordinator.js'
      );
      const empty = {
        version: '1',
        timestamp: 0,
        objects: {},
      } as never;
      // A consumer contribution carries no settling build-schema writer.
      await contributeSvelteKitRoutes({}, ['consumer'], root, {
        owner: 'consumer',
        routeManifest: empty,
        semanticManifest: empty,
        options: {
          enabled: true,
          routesDir: 'src/routes/api',
          objectsDir: 'src/lib/objects',
          changesRoute: { enabled: false },
          eventsRoute: { enabled: false },
          resourcesRoute: { enabled: false },
          rejectRouteCollisions: true,
        },
      });
      expect(existsSync(join(root, '.smrt/build-schema.js'))).toBe(true);
      const registration = readFileSync(
        join(root, 'src/lib/server/smrt-register.ts'),
        'utf8',
      );
      expect(registration).toContain('.smrt/build-schema.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a clean zero-package smrtConsumer config hook leaves a resolvable build-schema import', async () => {
    const root = resolve(
      import.meta.dirname,
      `__test-consumer-zero-packages-hook-${process.pid}`,
    );
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: '@test/zero-packages', type: 'module' }),
      );
      // Installed so the registration can import it, but neither configured
      // nor discovered (disableScanning): the consumer aggregates zero packages.
      const provider = join(root, 'node_modules', '@acme', 'widgets');
      mkdirSync(join(provider, 'dist'), { recursive: true });
      writeFileSync(
        join(provider, 'package.json'),
        JSON.stringify({
          name: '@acme/widgets',
          version: '1.0.0',
          exports: { '.': './dist/index.js' },
        }),
      );
      writeFileSync(
        join(provider, 'dist/index.js'),
        'export class Widget {}\n',
      );
      const { serializeSmrtGenerationSnapshot, sha256SmrtGenerationSnapshot } =
        await import('../generation-snapshot.js');
      const { smrtConsumer } = await import('./index.js');
      // No package is configured or discovered: the hosted object comes
      // from a verified generation snapshot.
      const provenance = 'git-tree:zero-packages';
      const contents = serializeSmrtGenerationSnapshot(
        {
          version: '1.0.0',
          timestamp: 0,
          packageName: '@test/zero-packages',
          objects: {
            '@acme/widgets:Widget': {
              className: 'Widget',
              qualifiedName: '@acme/widgets:Widget',
              packageName: '@acme/widgets',
              collection: 'widgets',
              fields: {},
              methods: {},
              decoratorConfig: { api: { include: ['list', 'get'] } },
            },
          },
        },
        provenance,
        { sourceRoot: root },
      );
      const snapshotPath = join(root, 'generation-snapshot.json');
      writeFileSync(snapshotPath, contents);
      const plugin = smrtConsumer({
        projectRoot: root,
        disableScanning: true,
        generateTypes: false,
        generationSnapshot: {
          path: snapshotPath,
          sha256: sha256SmrtGenerationSnapshot(contents),
          provenance,
          sourceRoot: root,
        },
        svelteKit: {
          objects: ['@acme/widgets:Widget'],
          changesRoute: { enabled: false },
          eventsRoute: { enabled: false },
          resourcesRoute: { enabled: false },
        },
      }) as unknown as { config: unknown };
      const hook = plugin.config as
        | ((...args: unknown[]) => unknown)
        | { handler: (...args: unknown[]) => unknown };
      const handler = typeof hook === 'function' ? hook : hook.handler;
      await handler.call(
        plugin,
        { root, plugins: [plugin] },
        { command: 'build', mode: 'production' },
      );

      const registrationDir = join(root, 'src/lib/server');
      const registration = readFileSync(
        join(registrationDir, 'smrt-register.ts'),
        'utf8',
      );
      const specifier = /import '([^']*build-schema\.js)';/.exec(
        registration,
      )?.[1];
      expect(specifier).toBeDefined();
      expect(existsSync(resolve(registrationDir, specifier ?? ''))).toBe(true);
      expect(existsSync(join(root, 'src/routes/api/widgets/+server.ts'))).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
