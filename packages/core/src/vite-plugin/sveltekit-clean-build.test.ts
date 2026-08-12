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

describe('SvelteKit clean build route generation (#2313)', () => {
  const projectRoot = resolve(
    import.meta.dirname,
    `__test-sveltekit-clean-build-${process.pid}`,
  );

  afterEach(() => {
    if (existsSync(projectRoot)) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('includes generated item routes in the first build with documented plugin order', async () => {
    mkdirSync(join(projectRoot, 'src/lib/objects'), { recursive: true });
    mkdirSync(join(projectRoot, 'src/lib/server'), { recursive: true });
    mkdirSync(join(projectRoot, 'src/routes'), { recursive: true });

    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'smrt-clean-build-fixture',
        private: true,
        type: 'module',
        dependencies: { '@happyvertical/smrt-core': '*' },
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
      '<h1>Clean build fixture</h1>\n',
    );
    writeFileSync(
      join(projectRoot, 'src/lib/objects/Item.ts'),
      [
        "import { SmrtObject, smrt } from '@happyvertical/smrt-core';",
        '',
        "@smrt({ api: { include: ['list', 'get'] } })",
        'export class Item extends SmrtObject {',
        "  title: string = '';",
        '}',
        '',
      ].join('\n'),
    );
    // Keep the integration focused on filesystem route inventory. The real
    // generator preserves an app-owned collection factory, so provide the
    // smallest valid one and avoid exercising database bootstrap in SvelteKit's
    // post-build module analysis.
    writeFileSync(
      join(projectRoot, 'src/lib/server/smrt.ts'),
      'export async function getCollection() { return {}; }\n',
    );

    const consumerPluginUrl = pathToFileURL(
      resolve(import.meta.dirname, '../consumer-plugin/index.ts'),
    ).href;
    const smrtPluginUrl = pathToFileURL(
      resolve(import.meta.dirname, 'index.ts'),
    ).href;
    writeFileSync(
      join(projectRoot, 'vite.config.ts'),
      `import { sveltekit } from '@sveltejs/kit/vite';
import { smrtConsumer } from ${JSON.stringify(consumerPluginUrl)};
import { smrtPlugin } from ${JSON.stringify(smrtPluginUrl)};
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      '@happyvertical/smrt-core': ${JSON.stringify(resolve(import.meta.dirname, '../index.ts'))},
    },
  },
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  plugins: [
    sveltekit(),
    smrtConsumer({
      projectRoot: ${JSON.stringify(projectRoot)},
      packages: [],
      disableScanning: true,
      generateTypes: false,
      svelteKit: true,
    }),
    smrtPlugin({
      projectRoot: ${JSON.stringify(projectRoot)},
      include: ['src/lib/objects/**/*.ts'],
      generateTypes: false,
      svelteKit: {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
        configFileName: 'smrt.ts',
        changesRoute: { enabled: false },
        eventsRoute: { enabled: false },
      },
    }),
  ],
});
`,
    );

    const viteCli = resolve(
      import.meta.dirname,
      '../../node_modules/vite/bin/vite.js',
    );
    await execFileAsync(process.execPath, [viteCli, 'build'], {
      cwd: projectRoot,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 110_000,
    });

    const generatedRoute = join(
      projectRoot,
      'src/routes/api/items/[id]/+server.ts',
    );
    const serverManifest = join(
      projectRoot,
      '.svelte-kit/output/server/manifest-full.js',
    );
    expect(existsSync(generatedRoute)).toBe(true);
    expect(existsSync(serverManifest)).toBe(true);
    expect(readFileSync(serverManifest, 'utf8')).toContain('/api/items/[id]');
  }, 120_000);
});
